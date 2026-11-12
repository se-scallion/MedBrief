#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
114 挂号/抢号核心模块离线单元测试
纯内存断言，测试医生撮合优先级、时钟差公式、统一响应解析、8008判定与验证码拦截防护
"""

import email.utils
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# 将 tools/guahao 目录加入 sys.path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
GUAHAO_ROOT = os.path.dirname(CURRENT_DIR)
if GUAHAO_ROOT not in sys.path:
    sys.path.insert(0, GUAHAO_ROOT)

from core.client import (
    ApiRequestException,
    AuthException,
    CaptchaRequiredException,
    DutySoldOutException,
    GuahaoClient,
    GuahaoException,
)
from core.selector import DoctorSelector
from core.hospital import HospitalManager
from core.sniper import GuahaoSniper
from core.notifier import GuahaoNotifier


class TestGuahaoDoctorSelector(unittest.TestCase):
    """医生撮合引擎测试"""

    def setUp(self):
        self.mock_duties = [
            {
                "duty_code": "DUTY_001",
                "doctor_name": "江倩",
                "doctor_title": "主任医师",
                "duty_time": 1,  # 上午
                "remain_available": 0,  # 约满
                "status": "NO_VACANCY",
                "fee": 100.0,
            },
            {
                "duty_code": "DUTY_002",
                "doctor_name": "黄晓军",
                "doctor_title": "知名专家",
                "duty_time": 1,  # 上午
                "remain_available": 2,  # 有号
                "status": "AVAILABLE",
                "fee": 300.0,
            },
            {
                "duty_code": "DUTY_003",
                "doctor_name": "李主治",
                "doctor_title": "主治医师",
                "duty_time": 2,  # 下午
                "remain_available": 5,  # 有号
                "status": "AVAILABLE",
                "fee": 50.0,
            },
            {
                "duty_code": "DUTY_004",
                "doctor_name": "王副主任(特需)",
                "doctor_title": "副主任医师",
                "duty_time": 1,  # 上午
                "remain_available": 3,  # 有号
                "status": "AVAILABLE",
                "fee": 200.0,
            },
        ]

    def test_priority_match_first_available(self):
        """测试按优先级队列匹配：江倩约满，黄晓军有号，应匹配黄晓军"""
        selector = DoctorSelector(
            target_doctors=["江倩", "黄晓军", "李主治"],
            duty_time_pref=1,  # 上午
            allow_substitute=False,
        )
        matched, rank, is_sub = selector.match(self.mock_duties)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["doctor_name"], "黄晓军")
        self.assertEqual(matched["duty_code"], "DUTY_002")
        self.assertEqual(rank, 1)  # 优先级第 2 个
        self.assertFalse(is_sub)

    def test_duty_time_filter(self):
        """测试时段过滤：要求下午，黄晓军(上午)被排除，匹配李主治(下午)"""
        selector = DoctorSelector(
            target_doctors=["黄晓军", "李主治"],
            duty_time_pref=2,  # 仅下午
            allow_substitute=False,
        )
        matched, rank, is_sub = selector.match(self.mock_duties)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["doctor_name"], "李主治")
        self.assertEqual(matched["duty_time"], 2)
        self.assertFalse(is_sub)

    def test_fuzzy_substring_match(self):
        """测试子串模糊匹配：配置 '王副主任'，命中 '王副主任(特需)'"""
        selector = DoctorSelector(
            target_doctors=["王副主任"],
            duty_time_pref=1,
            allow_substitute=False,
        )
        matched, rank, is_sub = selector.match(self.mock_duties)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["doctor_name"], "王副主任(特需)")
        self.assertEqual(rank, 0)
        self.assertFalse(is_sub)

    def test_wildcard_match(self):
        """测试通配符 '*' 匹配任意有号医生"""
        selector = DoctorSelector(
            target_doctors=["*"],
            duty_time_pref=0,  # 全天
            allow_substitute=False,
        )
        matched, rank, is_sub = selector.match(self.mock_duties)
        self.assertIsNotNone(matched)
        self.assertEqual(matched["doctor_name"], "黄晓军")

    def test_substitute_policy(self):
        """测试替补策略：目标医生全无号时，若开启替补则返回首个可用号，若关闭则返回 None"""
        # 1. 未开启替补
        selector_no_sub = DoctorSelector(
            target_doctors=["不存在的医生", "江倩"],  # 江倩无号
            duty_time_pref=1,
            allow_substitute=False,
        )
        matched, rank, is_sub = selector_no_sub.match(self.mock_duties)
        self.assertIsNone(matched)
        self.assertEqual(rank, -1)
        self.assertFalse(is_sub)

        # 2. 开启替补
        selector_with_sub = DoctorSelector(
            target_doctors=["不存在的医生", "江倩"],
            duty_time_pref=1,
            allow_substitute=True,
        )
        matched, rank, is_sub = selector_with_sub.match(self.mock_duties)
        self.assertIsNotNone(matched)
        self.assertTrue(is_sub)
        self.assertEqual(rank, 999)
        self.assertEqual(matched["duty_code"], "DUTY_002")


class TestGuahaoHospitalTimeDiff(unittest.TestCase):
    """时钟差与时间同步测试"""

    def test_time_diff_calculation(self):
        """测试依据 Date 头计算 Δt 的数学模型"""
        client = GuahaoClient()
        mgr = HospitalManager(client=client)

        # 模拟响应头：假设服务器时间为 2026-11-20 08:30:00 GMT (1795163400)
        server_ts = 1795163400.0
        server_date_str = email.utils.formatdate(server_ts, usegmt=True)

        mock_resp = MagicMock()
        mock_resp.headers = {"Date": server_date_str}

        # 模拟客户端在 local_t_mid 接收到
        local_t_mid = 1795163399.85  # 本地时钟慢了 0.15 秒
        with patch.object(client, "get", return_value=mock_resp), \
             patch("time.time", side_effect=[local_t_mid - 0.05, local_t_mid + 0.05]):
            diff = mgr.calculate_time_diff(hospital_code="140", samples=1)

            # Δt = t_server - t_mid = 1795163400.0 - 1795163399.85 = +0.15s
            self.assertAlmostEqual(diff, 0.15, places=2)


class TestGuahaoClientResponse(unittest.TestCase):
    """统一响应解析与异常拦截测试"""

    def setUp(self):
        self.client = GuahaoClient(cmi_user_ticket="TEST_TICKET_123")

    def test_successful_response(self):
        """测试正常业务响应 (resCode == 0)"""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {}
        mock_resp.json.return_value = {
            "resCode": 0,
            "msg": "成功",
            "data": {"orderId": "ORD_999"},
        }

        with patch.object(self.client.session, "request", return_value=mock_resp):
            res = self.client.post("/web/order/save", json_data={})
            self.assertEqual(res["resCode"], 0)
            self.assertEqual(res["data"]["orderId"], "ORD_999")

    def test_duplicate_order_8008_handling(self):
        """测试 8008 重复订单自动识别为成功"""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {}
        mock_resp.json.return_value = {
            "resCode": 8008,
            "msg": "您已预约过该号源，请勿重复预约",
            "data": {"orderId": "EXISTING_ORDER_001"},
        }

        with patch.object(self.client.session, "request", return_value=mock_resp):
            res = self.client.post("/web/order/save", json_data={})
            self.assertEqual(res["resCode"], 8008)
            self.assertTrue(res["is_duplicate_success"])

    def test_captcha_interception_raises_exception(self):
        """测试验证码拦截：触发 CaptchaRequiredException 严禁破解"""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {}
        # 1. 明确错误码 10001
        mock_resp.json.return_value = {
            "resCode": 10001,
            "msg": "请输入图形验证码",
            "data": None,
        }

        with patch.object(self.client.session, "request", return_value=mock_resp):
            with self.assertRaises(CaptchaRequiredException):
                self.client.post("/web/product/confirm", json_data={})

        # 2. 文案命中风控关键词
        mock_resp.json.return_value = {
            "resCode": 9999,
            "msg": "系统检测到异常请求，请完成滑块安全验证",
            "data": None,
        }
        with patch.object(self.client.session, "request", return_value=mock_resp):
            with self.assertRaises(CaptchaRequiredException):
                self.client.post("/web/product/confirm", json_data={})

    def test_session_expired_raises_auth_exception(self):
        """测试登录态失效触发 AuthException"""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {}
        mock_resp.json.return_value = {
            "resCode": 2001,
            "msg": "用户未登录或 ticket 已过期",
            "data": None,
        }

        with patch.object(self.client.session, "request", return_value=mock_resp):
            with self.assertRaises(AuthException):
                self.client.get("/web/user/info")


class TestGuahaoSniperTwoPhase(unittest.TestCase):
    """两阶段抢号流程与异常转译测试"""

    def setUp(self):
        self.client = GuahaoClient(cmi_user_ticket="TEST_TICKET")
        self.hospital_mgr = HospitalManager(client=self.client)
        self.selector = DoctorSelector()
        self.notified_msgs = []

        def mock_notify(title, msg, urgent):
            self.notified_msgs.append((title, msg, urgent))

        self.sniper = GuahaoSniper(
            client=self.client,
            hospital_manager=self.hospital_mgr,
            selector=self.selector,
            on_notify=mock_notify,
        )

    def test_successful_two_phase_booking(self):
        """测试完整的两阶段挂号流程 (锁定 -> 下单)"""
        duty_item = {
            "duty_code": "DUTY_123",
            "doctor_name": "江倩",
            "duty_date": "2026-11-20",
        }

        with patch.object(self.sniper, "confirm_product", return_value={"orderConfirmToken": "TOK_ABC"}):
            with patch.object(self.sniper, "save_order", return_value={"success": True, "order_id": "ORD_777"}):
                res = self.sniper.execute_two_phase_booking(
                    duty_item=duty_item,
                    hospital_code="140",
                    patient_id="PAT_01",
                    card_id="CARD_01",
                )
                self.assertTrue(res["success"])
                self.assertEqual(res["order_id"], "ORD_777")
                self.assertEqual(res["duty_item"]["duty_code"], "DUTY_123")

    def test_save_order_8008_duplicate_success(self):
        """测试 save_order 针对 8008 返回判定为成功"""
        with patch.object(
            self.client,
            "post",
            return_value={"resCode": 8008, "is_duplicate_success": True, "msg": "已存在预约", "data": {"orderId": "ORD_DUP_888"}},
        ):
            res = self.sniper.save_order(
                duty_code="DUTY_123",
                hospital_code="140",
                patient_id="PAT_01",
            )
            self.assertTrue(res["success"])
            self.assertTrue(res["is_duplicate"])
            self.assertEqual(res["order_id"], "ORD_DUP_888")

    def test_captcha_triggers_urgent_alert(self):
        """测试验证码拦截触发紧急告警通知"""
        with patch.object(self.client, "post", side_effect=CaptchaRequiredException("人机验证拦截")):
            with self.assertRaises(CaptchaRequiredException):
                self.sniper.confirm_product(duty_code="DUTY_123", hospital_code="140")

            self.assertTrue(len(self.notified_msgs) > 0)
            self.assertIn("验证码拦截", self.notified_msgs[0][0])
            self.assertTrue(self.notified_msgs[0][2])  # is_urgent


if __name__ == "__main__":
    unittest.main(verbosity=2)
