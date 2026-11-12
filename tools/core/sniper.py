# -*- coding: utf-8 -*-
"""
两阶段抢号与极速冲刺引擎 (GuahaoSniper)
实现 114 官方两阶段协议 (锁定 /web/product/confirm -> 下单 /web/order/save)
严格遵守安全合规原则（不破解验证码，捕获拦截即报送告警）
对 resCode == 8008 重复订单判定为成功，避免漏单
"""

from datetime import datetime, time as dt_time, timedelta
import logging
import random
import time
from typing import Any, Callable, Dict, List, Optional, Tuple
from .client import (
    ApiRequestException,
    AuthException,
    CaptchaRequiredException,
    DuplicateOrderException,
    GuahaoClient,
    GuahaoException,
)
from .hospital import HospitalManager
from .selector import DoctorSelector

logger = logging.getLogger("guahao.sniper")


class BookingFailedException(GuahaoException):
    """下单失败异常"""
    pass


class GuahaoSniper:
    """两阶段抢号与巡检引擎"""

    def __init__(
        self,
        client: GuahaoClient,
        hospital_manager: HospitalManager,
        selector: DoctorSelector,
        on_notify: Optional[Callable[[str, str, bool], None]] = None,
    ):
        self.client = client
        self.hospital_mgr = hospital_manager
        self.selector = selector
        self.on_notify = on_notify

    def _trigger_alert(self, title: str, message: str, is_urgent: bool = False) -> None:
        """触发通知回调"""
        if self.on_notify:
            try:
                self.on_notify(title, message, is_urgent)
            except Exception as e:
                logger.error("通知回调触发异常: %s", e)

    def confirm_product(
        self,
        duty_code: str,
        hospital_code: str,
        first_dept_code: str = "",
        second_dept_code: str = "",
        target_date: str = "",
    ) -> Dict[str, Any]:
        """
        第一阶段：锁定号源产品 (/web/product/confirm)
        """
        payload = {
            "dutyCode": str(duty_code).strip(),
            "hospitalCode": str(hospital_code).strip(),
        }
        if first_dept_code:
            payload["firstDeptCode"] = str(first_dept_code).strip()
        if second_dept_code:
            payload["secondDeptCode"] = str(second_dept_code).strip()
        if target_date:
            payload["target"] = str(target_date).strip()

        logger.info("阶段一：发送号源锁定请求 -> dutyCode: %s", duty_code)
        try:
            res = self.client.post("/web/product/confirm", json_data=payload)
            # 若触发重复订单 (8008)
            if isinstance(res, dict) and res.get("is_duplicate_success"):
                return res
            data = res.get("data") or {}
            logger.info("阶段一锁定成功")
            return data
        except CaptchaRequiredException as e:
            self._trigger_alert("【114 挂号警报】触发验证码拦截", f"锁定号源 {duty_code} 时被安全风控拦截，请人工接管！", is_urgent=True)
            raise
        except Exception as e:
            logger.error("阶段一锁定失败: %s", e)
            raise

    def save_order(
        self,
        duty_code: str,
        hospital_code: str,
        patient_id: str,
        card_id: str = "",
        confirm_data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        第二阶段：下单确认 (/web/order/save)
        返回订单结果。若遇到 resCode 8008（重复订单）判定为成功。
        """
        payload: Dict[str, Any] = {
            "dutyCode": str(duty_code).strip(),
            "hospitalCode": str(hospital_code).strip(),
            "patientId": str(patient_id).strip(),
        }
        if card_id:
            payload["cardId"] = str(card_id).strip()

        # 传递 confirm 阶段产生的 token 或 detail
        if confirm_data:
            if "orderConfirmToken" in confirm_data:
                payload["orderConfirmToken"] = confirm_data["orderConfirmToken"]
            if "detail" in confirm_data and isinstance(confirm_data["detail"], dict):
                payload.update({
                    k: v for k, v in confirm_data["detail"].items()
                    if k not in payload and v is not None
                })

        logger.info("阶段二：发送下单请求 -> dutyCode: %s, patientId: %s", duty_code, patient_id)
        try:
            res = self.client.post("/web/order/save", json_data=payload)
            if isinstance(res, dict) and res.get("is_duplicate_success"):
                logger.info("阶段二下单返回 8008（检测到已有预约单），判定为挂号成功！")
                return {
                    "success": True,
                    "is_duplicate": True,
                    "order_id": (res.get("data") or {}).get("orderId") or "ALREADY_EXISTS",
                    "msg": "已预约过该号源（重复订单判定为成功）",
                    "raw": res,
                }

            order_data = res.get("data") or {}
            order_id = str(order_data.get("orderId") or order_data.get("id") or "")
            logger.info("阶段二下单成功！订单号: %s", order_id)
            return {
                "success": True,
                "is_duplicate": False,
                "order_id": order_id,
                "msg": res.get("msg") or "预约成功",
                "raw": res,
            }
        except CaptchaRequiredException as e:
            self._trigger_alert("【114 挂号警报】触发验证码拦截", f"提交订单 {duty_code} 时被安全风控拦截，请人工接管！", is_urgent=True)
            raise
        except ApiRequestException as e:
            if e.res_code == 8008:
                logger.info("阶段二捕获 8008 异常，按业务契约判定为预约成功！")
                return {
                    "success": True,
                    "is_duplicate": True,
                    "order_id": "8008_DUPLICATE_SUCCESS",
                    "msg": "您已预约过该号源（判定成功）",
                }
            raise BookingFailedException(f"下单失败: {e.msg} (代码: {e.res_code})") from e

    def execute_two_phase_booking(
        self,
        duty_item: Dict[str, Any],
        hospital_code: str,
        patient_id: str,
        card_id: str = "",
        first_dept_code: str = "",
        second_dept_code: str = "",
        target_date: str = "",
    ) -> Dict[str, Any]:
        """执行完整两阶段挂号流程"""
        duty_code = duty_item.get("duty_code")
        doc_name = duty_item.get("doctor_name")
        logger.info("开始执行两阶段抢号: 医生 %s | 号源代码 %s", doc_name, duty_code)

        # 阶段 1：锁定
        confirm_res = self.confirm_product(
            duty_code=duty_code,
            hospital_code=hospital_code,
            first_dept_code=first_dept_code,
            second_dept_code=second_dept_code,
            target_date=target_date,
        )

        if isinstance(confirm_res, dict) and confirm_res.get("is_duplicate_success"):
            return {
                "success": True,
                "is_duplicate": True,
                "duty_item": duty_item,
                "order_id": "CONFIRM_8008_SUCCESS",
                "msg": "锁定阶段检测到已有订单，判定成功",
            }

        # 阶段 2：下单
        save_res = self.save_order(
            duty_code=duty_code,
            hospital_code=hospital_code,
            patient_id=patient_id,
            card_id=card_id,
            confirm_data=confirm_res,
        )

        result = {
            **save_res,
            "duty_item": duty_item,
        }
        return result

    def burst_booking(
        self,
        hospital_code: str,
        first_dept_code: str,
        second_dept_code: str,
        target_date: str,
        patient_id: str,
        card_id: str = "",
        open_time_str: str = "08:30",
        delta_ms: int = 120,
        burst_interval_ms: int = 150,
        max_retry: int = 25,
        target_doctors: Optional[List[str]] = None,
        duty_time_pref: int = 0,
        allow_substitute: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """
        放号时点倒计时冲刺模式 (burst)
        1. 获取/校验 Δt
        2. 计算目标时点，倒计时等待
        3. 达到 (T_release - Δt - delta_ms) 时点触发高频发包冲刺
        """
        logger.info("=== 启动放号冲刺模式 (BURST) ===")
        logger.info(
            "目标: 医院 %s | 科室 %s/%s | 日期 %s | 放号时间 %s",
            hospital_code, first_dept_code, second_dept_code, target_date, open_time_str
        )

        # 1. 计算服务器时钟差 Δt
        delta_t = self.hospital_mgr.calculate_time_diff(hospital_code=hospital_code)

        # 2. 计算本地目标唤醒时戳
        now = datetime.now()
        open_hour, open_minute = map(int, open_time_str.split(":")[:2])
        target_dt = datetime(now.year, now.month, now.day, open_hour, open_minute, 0)
        if target_dt < now:
            # 如果当天的放号时间已经过了，则以今天当前时间立即执行或者以明天计算
            logger.warning("目标放号时点 %s 已过，以当前时点立即启动冲刺！", open_time_str)
            target_timestamp = time.time()
        else:
            target_timestamp = target_dt.timestamp()

        # 核心发包提前量：T_local_trigger = T_server_release - Δt - (delta_ms / 1000)
        advance_sec = (delta_ms / 1000.0)
        local_trigger_time = target_timestamp - delta_t - advance_sec

        logger.info(
            "时钟补偿对齐: 放号时刻 %s, 时钟差 Δt = %+.3fs, 本地提前量 = %dms, 预计本地触发时戳 = %.3f",
            open_time_str, delta_t, delta_ms, local_trigger_time
        )

        # 倒计时等待
        while True:
            remaining = local_trigger_time - time.time()
            if remaining <= 0:
                break
            if remaining > 10:
                logger.info("距离冲刺还有 %.1f 秒...", remaining)
                time.sleep(min(remaining - 5, 5))
            elif remaining > 1:
                logger.info("倒计时: %.1f 秒...", remaining)
                time.sleep(0.5)
            else:
                # 最后一秒采用微休眠紧凑轮询
                time.sleep(0.02)

        logger.info("🚀 达到触发阈值，立即启动高频冲刺发包！")

        # 3. 紧凑轮询冲刺
        for attempt in range(1, max_retry + 1):
            logger.info("冲刺尝试 [%d/%d] ...", attempt, max_retry)
            try:
                # 获取排班
                duty_list = self.hospital_mgr.get_duty_list(
                    hospital_code=hospital_code,
                    first_dept_code=first_dept_code,
                    second_dept_code=second_dept_code,
                    target_date=target_date,
                )
                if not duty_list:
                    time.sleep(burst_interval_ms / 1000.0)
                    continue

                # 医生撮合
                matched, rank, is_sub = self.selector.match(
                    duty_list=duty_list,
                    custom_targets=target_doctors,
                    custom_duty_time=duty_time_pref,
                    custom_allow_substitute=allow_substitute,
                )

                if matched:
                    logger.info("🎯 冲刺命中号源: %s (余号: %s)", matched.get("doctor_name"), matched.get("remain_available"))
                    result = self.execute_two_phase_booking(
                        duty_item=matched,
                        hospital_code=hospital_code,
                        patient_id=patient_id,
                        card_id=card_id,
                        first_dept_code=first_dept_code,
                        second_dept_code=second_dept_code,
                        target_date=target_date,
                    )
                    if result.get("success"):
                        self._trigger_alert(
                            "🎉【114 挂号成功】",
                            f"已成功抢到 {matched.get('doctor_name')} ({matched.get('duty_date')}) 的号！订单号: {result.get('order_id')}",
                            is_urgent=True,
                        )
                        return result

            except CaptchaRequiredException:
                logger.critical("冲刺过程中遭遇验证码拦截，退出冲刺！")
                raise
            except Exception as e:
                logger.warning("冲刺尝试 #%d 失败: %s", attempt, e)

            time.sleep(burst_interval_ms / 1000.0)

        logger.warning("冲刺完成，未能抢到目标号源")
        return None

    def watch_patrol(
        self,
        hospital_code: str,
        first_dept_code: str,
        second_dept_code: str,
        target_date: str,
        patient_id: str,
        card_id: str = "",
        watch_interval_sec: float = 5.0,
        watch_jitter_sec: float = 2.0,
        target_doctors: Optional[List[str]] = None,
        duty_time_pref: int = 0,
        allow_substitute: bool = False,
        max_patrol_rounds: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        长效捡漏巡检模式 (watch)
        低频+随机抖动巡检目标科室，一旦发现余号立即锁定下单
        """
        logger.info("=== 启动长效捡漏巡检模式 (WATCH) ===")
        round_idx = 0

        while True:
            round_idx += 1
            if max_patrol_rounds and round_idx > max_patrol_rounds:
                logger.info("已达到设定的最大巡检轮数 %d，退出巡检", max_patrol_rounds)
                break

            logger.info("巡检轮次 #%d: 检查 %s 号源状态...", round_idx, target_date)
            try:
                duty_list = self.hospital_mgr.get_duty_list(
                    hospital_code=hospital_code,
                    first_dept_code=first_dept_code,
                    second_dept_code=second_dept_code,
                    target_date=target_date,
                )

                matched, rank, is_sub = self.selector.match(
                    duty_list=duty_list,
                    custom_targets=target_doctors,
                    custom_duty_time=duty_time_pref,
                    custom_allow_substitute=allow_substitute,
                )

                if matched:
                    logger.info("🎉 巡检发现余号！医生: %s (余号: %s)", matched.get("doctor_name"), matched.get("remain_available"))
                    result = self.execute_two_phase_booking(
                        duty_item=matched,
                        hospital_code=hospital_code,
                        patient_id=patient_id,
                        card_id=card_id,
                        first_dept_code=first_dept_code,
                        second_dept_code=second_dept_code,
                        target_date=target_date,
                    )
                    if result.get("success"):
                        self._trigger_alert(
                            "🎉【114 捡漏成功】",
                            f"已成功捡漏挂号: {matched.get('doctor_name')} ({matched.get('duty_date')})！订单号: {result.get('order_id')}",
                            is_urgent=True,
                        )
                        return result

            except CaptchaRequiredException:
                logger.critical("巡检过程中遭遇验证码拦截，立即终止！")
                raise
            except Exception as e:
                logger.warning("巡检轮次 #%d 异常: %s", round_idx, e)

            # 随机抖动等待，避免固定频率被风控
            jitter = random.uniform(-watch_jitter_sec, watch_jitter_sec)
            actual_sleep = max(1.0, watch_interval_sec + jitter)
            logger.debug("巡检等待 %.2f 秒...", actual_sleep)
            time.sleep(actual_sleep)

        return None
