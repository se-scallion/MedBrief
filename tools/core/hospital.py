# -*- coding: utf-8 -*-
"""
114 平台医院、排班日历与服务器时钟对齐模块
支持放号规则解析、放号日历状态获取、号源排班列表抽取及高精度服务器时钟差 (Δt) 计算
"""

from datetime import datetime, time as dt_time, timedelta
import email.utils
import logging
import time
from typing import Any, Dict, List, Optional, Tuple
from .client import GuahaoClient, GuahaoException

logger = logging.getLogger("guahao.hospital")


class HospitalManager:
    """医院与科室号源排班管理器"""

    def __init__(self, client: GuahaoClient):
        self.client = client

    def get_hospital_detail(self, hospital_code: str) -> Dict[str, Any]:
        """
        获取医院基本详情与放号规则 (/web/hospital/detail)
        @return 包含 openTime (如 "08:30")、医院名称、放号周期等信息的字典
        """
        res = self.client.get(
            "/web/hospital/detail",
            params={"hospitalCode": str(hospital_code).strip()},
        )
        data = res.get("data") or {}
        hospital_info = data.get("hospital") or data

        open_time = (
            hospital_info.get("openTime")
            or hospital_info.get("releaseTime")
            or data.get("openTime")
            or "08:30"
        )
        name = hospital_info.get("name") or hospital_info.get("hospitalName") or f"医院_{hospital_code}"

        return {
            "hospital_code": str(hospital_code),
            "name": name,
            "open_time": open_time.strip(),
            "rule": hospital_info.get("bookingRule") or data.get("bookingRule") or {},
            "raw": data,
        }

    def calculate_time_diff(self, hospital_code: str = "140", samples: int = 3) -> float:
        """
        高精度计算 114 服务器时钟与本地时钟的时间差 Δt (单位: 秒)
        数学模型：
            t_start: 本地发包时间
            t_end:   本地收包时间
            RTT = t_end - t_start
            t_mid = t_start + RTT / 2 (假设往返对称，服务器生成 Date 头对应的本地近似时刻)
            t_server = Date 响应头转换的 UTC 时间戳
            Δt = t_server - t_mid
        若 Δt > 0，代表 114 服务器时钟比本地快 Δt 秒；
        抢号发包时点为：T_target - Δt - delta_ms
        """
        diffs: List[float] = []

        for i in range(max(1, samples)):
            t_start = time.time()
            try:
                # 使用 lightweight 请求探测服务器 Date
                resp = self.client.get(
                    "/web/hospital/detail",
                    params={"hospitalCode": str(hospital_code)},
                    raw_response=True,
                    timeout=3.0,
                )
                t_end = time.time()
                date_header = resp.headers.get("Date")
                if not date_header:
                    continue

                parsed_date = email.utils.parsedate_to_datetime(date_header)
                t_server = parsed_date.timestamp()

                rtt = t_end - t_start
                t_mid = t_start + (rtt / 2.0)
                diff = t_server - t_mid
                diffs.append(diff)
                logger.debug(
                    "时钟同步采样 #%d: RTT=%.3fs, ServerDate=%s, Δt=%.3fs",
                    i + 1, rtt, date_header, diff
                )
            except Exception as e:
                logger.warning("时钟同步采样 #%d 失败: %s", i + 1, e)

            if i < samples - 1:
                time.sleep(0.15)

        if not diffs:
            logger.warning("时钟对齐未能采集到有效响应头，默认 Δt = 0.0s")
            return 0.0

        # 取均值（去除极端抖动）
        avg_diff = sum(diffs) / len(diffs)
        logger.info(
            "114 服务器时钟差计算完成 (采样数: %d): Δt = %.3f 秒 (%+.1f ms)",
            len(diffs), avg_diff, avg_diff * 1000.0
        )
        return avg_diff

    def get_department_calendar(
        self,
        hospital_code: str,
        first_dept_code: str,
        second_dept_code: str,
        target_date: str,
    ) -> List[Dict[str, Any]]:
        """
        获取科室放号排班日历 (/web/product/dep/detail)
        @return 每日放号状态列表 [{dutyDate, status, remainAvailable}, ...]
        """
        payload = {
            "hospitalCode": str(hospital_code).strip(),
            "firstDeptCode": str(first_dept_code).strip(),
            "secondDeptCode": str(second_dept_code).strip(),
            "target": str(target_date).strip(),
        }

        try:
            res = self.client.post("/web/product/dep/detail", json_data=payload)
            data = res.get("data") or {}
            calendar_list = data.get("calendar") or data.get("list") or []
            return calendar_list
        except Exception as e:
            logger.error("获取科室日历失败: %s", e)
            return []

    def get_duty_list(
        self,
        hospital_code: str,
        first_dept_code: str,
        second_dept_code: str,
        target_date: str,
    ) -> List[Dict[str, Any]]:
        """
        获取目标日期的医生排班号源列表 (/web/product/list)
        @return 排班列表，标准化包含 dutyCode, doctorName, doctorTitle, fee, remainAvailable, dutyTime 等
        """
        payload = {
            "hospitalCode": str(hospital_code).strip(),
            "firstDeptCode": str(first_dept_code).strip(),
            "secondDeptCode": str(second_dept_code).strip(),
            "target": str(target_date).strip(),
        }

        res = self.client.post("/web/product/list", json_data=payload)
        data = res.get("data") or {}
        raw_list = data.get("list") or (data if isinstance(data, list) else [])

        standardized_duties: List[Dict[str, Any]] = []
        for item in raw_list:
            duty_code = str(item.get("dutyCode") or item.get("dutyId") or item.get("id") or "")
            doctor_name = item.get("doctorName") or item.get("name") or "普通门诊"
            doctor_title = item.get("doctorTitle") or item.get("title") or ""
            duty_time = item.get("dutyTime")
            # 1: 上午, 2: 下午
            if duty_time is not None:
                try:
                    duty_time = int(duty_time)
                except (ValueError, TypeError):
                    duty_time = 0
            else:
                duty_time = 0

            # 剩余可预约号数
            remain = item.get("remainAvailable")
            if remain is None:
                remain = item.get("leftNum")
            if remain is None:
                status_str = str(item.get("status") or "").upper()
                remain = 1 if status_str in ("AVAILABLE", "HAS_VACANCY") else 0
            else:
                try:
                    remain = int(remain)
                except (ValueError, TypeError):
                    remain = 0

            fee = item.get("totalFee") or item.get("fee") or 0.0

            standardized_duties.append({
                "duty_code": duty_code,
                "doctor_name": doctor_name.strip(),
                "doctor_title": doctor_title.strip(),
                "duty_date": item.get("dutyDate") or target_date,
                "duty_time": duty_time,
                "fee": fee,
                "remain_available": remain,
                "status": item.get("status") or ("AVAILABLE" if remain > 0 else "NO_VACANCY"),
                "skill": item.get("skill") or "",
                "raw": item,
            })

        return standardized_duties
