#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
114 挂号/抢号核心引擎与 Node 服务 Bridge 适配器
通过 stdin/stdout JSON 通信，提供会话检测、时钟同步、真实号源抓取与两阶段抢号
"""

import json
import logging
import os
import sys

# 抑制 urllib3 警告
import warnings
warnings.filterwarnings("ignore")

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from core.client import GuahaoClient, AuthException, CaptchaRequiredException, GuahaoException
from core.auth import is_login, check_session, get_patient_list, resolve_patient_and_card
from core.hospital import HospitalManager
from core.selector import DoctorSelector
from core.sniper import GuahaoSniper

logging.basicConfig(level=logging.WARNING)


def run_bridge():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"ok": False, "error": "Empty input"}))
            return

        payload = json.loads(raw_input)
        action = payload.get("action")
        ticket = str(payload.get("ticket") or "").strip()
        cookie_str = str(payload.get("cookie") or "").strip()
        hospital_code = str(payload.get("hospitalCode") or "142").strip()

        client = GuahaoClient(cmi_user_ticket=ticket, cookie_str=cookie_str, timeout=6.0)
        hospital_mgr = HospitalManager(client=client)

        if action == "ping":
            # 基础探活
            print(json.dumps({"ok": True, "engine": "114-python-core", "status": "ready"}))
            return

        elif action == "time_diff":
            # 测量 114 服务器时钟差
            try:
                diff = hospital_mgr.calculate_time_diff(hospital_code=hospital_code, samples=2)
                print(json.dumps({"ok": True, "deltaSeconds": diff, "deltaMs": round(diff * 1000, 1)}))
            except Exception as e:
                print(json.dumps({"ok": False, "error": str(e), "deltaSeconds": 0.0, "deltaMs": 0.0}))
            return

        elif action == "check_session":
            # 检测会话有效性
            if not ticket and not cookie_str:
                print(json.dumps({
                    "ok": False,
                    "isLogin": False,
                    "error": "未提供 114 会话票据 (cmi-user-ticket 或 Cookie)",
                }))
                return

            ok, info = is_login(client)
            if ok:
                patients = get_patient_list(client)
                print(json.dumps({
                    "ok": True,
                    "isLogin": True,
                    "user": {
                        "uid": info.get("uid") or info.get("id"),
                        "realName": info.get("realName") or info.get("name"),
                        "mobile": info.get("mobile") or info.get("phone"),
                    },
                    "patients": patients,
                }))
            else:
                print(json.dumps({
                    "ok": True,
                    "isLogin": False,
                    "error": "会话已过期或无效，请从 114 官网重新获取",
                }))
            return

        elif action == "fetch_real_schedule":
            # 获取真实科室排班号源
            first_dept = payload.get("firstDeptCode") or "14201"
            second_dept = payload.get("secondDeptCode") or "1420101"
            target_date = payload.get("targetDate") or ""
            try:
                duties = hospital_mgr.get_duty_list(
                    hospital_code=hospital_code,
                    first_dept_code=first_dept,
                    second_dept_code=second_dept,
                    target_date=target_date,
                )
                print(json.dumps({"ok": True, "duties": duties}))
            except Exception as e:
                print(json.dumps({"ok": False, "error": str(e)}))
            return

        else:
            print(json.dumps({"ok": False, "error": f"Unknown action: {action}"}))

    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    run_bridge()
