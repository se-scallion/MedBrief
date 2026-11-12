#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
114 北京市预约挂号平台挂号/抢号 CLI 客户端入口
支持：
  1. check: 检查登录态有效性、科室号源日历与撮合预览
  2. burst: 放号时点倒计时冲刺抢号 (时钟补偿 Δt + 提前量 delta_ms)
  3. watch: 长效自动捡漏巡检
"""

import argparse
import logging
import os
import sys
from typing import Any, Dict
import yaml

from core import (
    AuthException,
    CaptchaRequiredException,
    DoctorSelector,
    GuahaoClient,
    GuahaoNotifier,
    GuahaoSniper,
    HospitalManager,
    check_session,
)
from core.auth import resolve_patient_and_card

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("guahao.main")


def load_config(config_path: str = "config.yaml") -> Dict[str, Any]:
    """加载并解析 YAML 配置文件"""
    target_path = config_path
    if not os.path.exists(target_path):
        example_path = os.path.join(os.path.dirname(__file__), "config.example.yaml")
        if os.path.exists(example_path):
            logger.warning("未找到 %s，回退加载模板配置 %s", target_path, example_path)
            target_path = example_path
        else:
            logger.error("配置文件不存在: %s", target_path)
            sys.exit(1)

    try:
        with open(target_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
            logger.info("已加载配置文件: %s", target_path)
            return cfg
    except Exception as e:
        logger.error("解析配置文件失败: %s", e)
        sys.exit(1)


def build_components(cfg: Dict[str, Any]):
    """依据配置构建核心子组件"""
    auth_cfg = cfg.get("auth") or {}
    ticket = str(auth_cfg.get("cmi_user_ticket") or "").strip()
    cookie_str = str(auth_cfg.get("cookie") or "").strip()

    sniper_cfg = cfg.get("sniper") or {}
    timeout = float(sniper_cfg.get("timeout_sec") or 6.0)

    client = GuahaoClient(cmi_user_ticket=ticket, cookie_str=cookie_str, timeout=timeout)
    hospital_mgr = HospitalManager(client=client)

    target_cfg = cfg.get("target") or {}
    target_doctors = target_cfg.get("target_doctors") or []
    duty_time = int(target_cfg.get("duty_time") or 0)
    allow_substitute = bool(target_cfg.get("allow_substitute"))

    selector = DoctorSelector(
        target_doctors=target_doctors,
        duty_time_pref=duty_time,
        allow_substitute=allow_substitute,
    )

    notif_cfg = cfg.get("notification") or {}
    notifier = GuahaoNotifier(
        enable_sound=bool(notif_cfg.get("sound", True)),
        bark_url=str(notif_cfg.get("bark_url") or ""),
        serverchan_sendkey=str(notif_cfg.get("serverchan_sendkey") or ""),
        custom_webhook=str(notif_cfg.get("custom_webhook") or ""),
    )

    sniper = GuahaoSniper(
        client=client,
        hospital_manager=hospital_mgr,
        selector=selector,
        on_notify=notifier.notify,
    )

    return client, hospital_mgr, selector, notifier, sniper


def cmd_check(args, cfg: Dict[str, Any]) -> None:
    """执行 check 命令：校验会话、科室日历与撮合排班"""
    client, hospital_mgr, selector, notifier, _ = build_components(cfg)

    print("\n" + "=" * 60)
    print(" 🏥 114 挂号配置与号源诊断检查 (CHECK)")
    print("=" * 60)

    # 1. 会话校验
    try:
        user_info = check_session(client)
        print(f"  ✅ 登录状态有效: {user_info['real_name_masked']} ({user_info['mobile_masked']})")
    except AuthException as e:
        print(f"  ❌ 登录态失效: {e}")
        return

    # 2. 医院与放号信息
    target_cfg = cfg.get("target") or {}
    hosp_code = str(target_cfg.get("hospital_code") or "140")
    hosp_detail = hospital_mgr.get_hospital_detail(hosp_code)
    open_time = hosp_detail.get("open_time")
    print(f"  🏥 目标医院: {hosp_detail.get('name')} (代码: {hosp_code})")
    print(f"  ⏰ 每日放号时点: {open_time}")

    # 3. 服务器时钟差 Δt
    delta_t = hospital_mgr.calculate_time_diff(hospital_code=hosp_code)
    print(f"  ⏱️  114 时钟差 Δt: {delta_t:+.3f}s ({delta_t * 1000.0:+.1f}ms)")

    # 4. 科室号源列表
    first_dept = str(target_cfg.get("first_dept_code") or "")
    second_dept = str(target_cfg.get("second_dept_code") or "")
    target_date = str(target_cfg.get("target_date") or "")

    print(f"\n--- 📅 查询科室排班: {target_cfg.get('dept_name')} ({target_date}) ---")
    duty_list = hospital_mgr.get_duty_list(hosp_code, first_dept, second_dept, target_date)

    if not duty_list:
        print("  ⚠️  未查询到排班数据（可能未到放号时点或参数代码有误）")
    else:
        print(f"  共获取到 {len(duty_list)} 条排班记录:")
        for idx, d in enumerate(duty_list, 1):
            time_label = "上午" if d["duty_time"] == 1 else "下午" if d["duty_time"] == 2 else "全天"
            status_symbol = "🟢 [有号]" if d["remain_available"] > 0 else "⚪ [约满]"
            print(
                f"    {idx:2d}. {status_symbol} {d['doctor_name']:<8} "
                f"| {d['doctor_title']:<6} | {time_label} | 费用: ¥{d['fee']} | 余号: {d['remain_available']}"
            )

        # 撮合预览
        matched, rank, is_sub = selector.match(duty_list)
        print("\n--- 🎯 医生撮合引擎模拟结果 ---")
        if matched:
            sub_flag = " (替补策略)" if is_sub else f" (优先级 #{rank + 1})"
            print(f"  👉 命中目标: {matched['doctor_name']} ({matched['doctor_title']}){sub_flag}")
            print(f"     排班代码 dutyCode: {matched['duty_code']}")
        else:
            print("  ⚠️  当前没有排班符合配置的目标医生列表（且未开启/无可用替补）")

    print("=" * 60 + "\n")


def cmd_burst(args, cfg: Dict[str, Any]) -> None:
    """执行 burst 命令：倒计时冲刺抢号"""
    client, hospital_mgr, selector, notifier, sniper = build_components(cfg)

    # 1. 登录校验
    check_session(client)

    target_cfg = cfg.get("target") or {}
    hosp_code = str(target_cfg.get("hospital_code") or "140")
    first_dept = str(target_cfg.get("first_dept_code") or "")
    second_dept = str(target_cfg.get("second_dept_code") or "")
    target_date = str(target_cfg.get("target_date") or "")

    # 解析就诊人
    pat_info = resolve_patient_and_card(
        client=client,
        target_patient_name=target_cfg.get("patient_name", ""),
        config_patient_id=target_cfg.get("patient_id", ""),
        config_card_id=target_cfg.get("card_id", ""),
    )
    patient_id = pat_info["patient_id"]
    if not patient_id:
        logger.error("未指定或无法匹配到有效就诊人 ID，请检查配置文件 target.patient_id 或 target.patient_name！")
        sys.exit(1)

    # 获取放号时间
    hosp_detail = hospital_mgr.get_hospital_detail(hosp_code)
    open_time = hosp_detail.get("open_time") or "08:30"

    sniper_cfg = cfg.get("sniper") or {}
    delta_ms = int(sniper_cfg.get("delta_ms") or 120)
    burst_interval_ms = int(sniper_cfg.get("burst_interval_ms") or 150)
    max_retry = int(sniper_cfg.get("burst_max_retry") or 25)

    try:
        sniper.burst_booking(
            hospital_code=hosp_code,
            first_dept_code=first_dept,
            second_dept_code=second_dept,
            target_date=target_date,
            patient_id=patient_id,
            card_id=pat_info["card_id"],
            open_time_str=open_time,
            delta_ms=delta_ms,
            burst_interval_ms=burst_interval_ms,
            max_retry=max_retry,
            target_doctors=target_cfg.get("target_doctors"),
            duty_time_pref=int(target_cfg.get("duty_time") or 0),
            allow_substitute=bool(target_cfg.get("allow_substitute")),
        )
    except CaptchaRequiredException as e:
        logger.critical("遭遇验证码拦截，程序中止: %s", e)
        sys.exit(2)


def cmd_watch(args, cfg: Dict[str, Any]) -> None:
    """执行 watch 命令：长效捡漏巡检"""
    client, hospital_mgr, selector, notifier, sniper = build_components(cfg)

    # 1. 登录校验
    check_session(client)

    target_cfg = cfg.get("target") or {}
    hosp_code = str(target_cfg.get("hospital_code") or "140")
    first_dept = str(target_cfg.get("first_dept_code") or "")
    second_dept = str(target_cfg.get("second_dept_code") or "")
    target_date = str(target_cfg.get("target_date") or "")

    pat_info = resolve_patient_and_card(
        client=client,
        target_patient_name=target_cfg.get("patient_name", ""),
        config_patient_id=target_cfg.get("patient_id", ""),
        config_card_id=target_cfg.get("card_id", ""),
    )
    patient_id = pat_info["patient_id"]
    if not patient_id:
        logger.error("未指定或无法匹配到有效就诊人 ID，请检查配置文件！")
        sys.exit(1)

    sniper_cfg = cfg.get("sniper") or {}
    watch_interval_sec = float(sniper_cfg.get("watch_interval_sec") or 5.0)
    watch_jitter_sec = float(sniper_cfg.get("watch_jitter_sec") or 2.0)

    try:
        sniper.watch_patrol(
            hospital_code=hosp_code,
            first_dept_code=first_dept,
            second_dept_code=second_dept,
            target_date=target_date,
            patient_id=patient_id,
            card_id=pat_info["card_id"],
            watch_interval_sec=watch_interval_sec,
            watch_jitter_sec=watch_jitter_sec,
            target_doctors=target_cfg.get("target_doctors"),
            duty_time_pref=int(target_cfg.get("duty_time") or 0),
            allow_substitute=bool(target_cfg.get("allow_substitute")),
        )
    except CaptchaRequiredException as e:
        logger.critical("巡检遭遇验证码拦截，程序中止: %s", e)
        sys.exit(2)


def main():
    parser = argparse.ArgumentParser(description="114 北京市预约挂号统一平台抢号/挂号助手")
    parser.add_argument(
        "-c", "--config",
        default="config.yaml",
        help="配置文件路径 (默认: config.yaml，若不存在自动尝试 config.example.yaml)",
    )

    subparsers = parser.add_subparsers(dest="command", help="操作子命令")

    # check
    subparsers.add_parser("check", help="检查登录有效性、时钟差与科室号源日历")

    # burst
    subparsers.add_parser("burst", help="放号时点倒计时冲刺模式")

    # watch
    subparsers.add_parser("watch", help="长效捡漏巡检模式")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    cfg = load_config(args.config)

    if args.command == "check":
        cmd_check(args, cfg)
    elif args.command == "burst":
        cmd_burst(args, cfg)
    elif args.command == "watch":
        cmd_watch(args, cfg)


if __name__ == "__main__":
    main()
