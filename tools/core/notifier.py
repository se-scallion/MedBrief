# -*- coding: utf-8 -*-
"""
多通道告警与通知模块 (GuahaoNotifier)
支持终端响铃 (\a)、macOS 系统级音频告警 (afplay)、控制台置顶高亮横幅、Bark 及 Server酱/Webhook 推送
"""

import json
import logging
import os
import platform
import subprocess
import sys
from typing import Optional
import requests

logger = logging.getLogger("guahao.notifier")


class GuahaoNotifier:
    """多通道通知管理器"""

    def __init__(
        self,
        enable_sound: bool = True,
        bark_url: str = "",
        serverchan_sendkey: str = "",
        custom_webhook: str = "",
    ):
        self.enable_sound = enable_sound
        self.bark_url = bark_url.strip()
        self.serverchan_sendkey = serverchan_sendkey.strip()
        self.custom_webhook = custom_webhook.strip()

    def play_sound(self, is_urgent: bool = False) -> None:
        """播放音频告警"""
        if not self.enable_sound:
            return

        # 1. 终端铃声
        sys.stdout.write("\a")
        sys.stdout.flush()

        # 2. macOS afplay 播放系统音效
        if platform.system() == "Darwin":
            try:
                sound_file = (
                    "/System/Library/Sounds/Ping.aiff"
                    if not is_urgent
                    else "/System/Library/Sounds/Sosumi.aiff"
                )
                if not os.path.exists(sound_file):
                    sound_file = "/System/Library/Sounds/Glass.aiff"

                if os.path.exists(sound_file):
                    subprocess.Popen(
                        ["afplay", sound_file],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
            except Exception as e:
                logger.debug("播放系统音效失败: %s", e)

    def print_banner(self, title: str, message: str, is_urgent: bool = False) -> None:
        """控制台高亮横幅置顶打印"""
        # ANSI 颜色转义码
        color_code = "\033[1;31m" if is_urgent else "\033[1;32m"  # 红 / 绿
        reset_code = "\033[0m"

        width = 64
        border = "=" * width
        print(f"\n{color_code}{border}")
        print(f"  🔔 {title.center(width - 6)}")
        print(f"{border}{reset_code}")
        for line in message.split("\n"):
            print(f"  {line}")
        print(f"{color_code}{border}{reset_code}\n", flush=True)

    def send_bark(self, title: str, message: str, is_urgent: bool = False) -> None:
        """推送 Bark (iOS)"""
        if not self.bark_url:
            return

        base = self.bark_url.rstrip("/")
        # Bark 支持 POST 或 GET
        try:
            payload = {
                "title": title,
                "body": message,
                "group": "114挂号",
                "sound": "alarm" if is_urgent else "glass",
            }
            resp = requests.post(f"{base}/push", json=payload, timeout=4.0)
            logger.info("Bark 推送回执: %s", resp.status_code)
        except Exception as e:
            logger.warning("Bark 推送异常: %s", e)

    def send_serverchan(self, title: str, message: str) -> None:
        """推送 Server酱 (微信服务号)"""
        if not self.serverchan_sendkey:
            return

        url = f"https://sctapi.ftqq.com/{self.serverchan_sendkey}.send"
        try:
            data = {"title": title, "desp": message}
            resp = requests.post(url, data=data, timeout=4.0)
            logger.info("Server酱推送回执: %s", resp.status_code)
        except Exception as e:
            logger.warning("Server酱推送异常: %s", e)

    def send_custom_webhook(self, title: str, message: str) -> None:
        """推送企业微信 / 飞书 / 钉钉自定义机器人 Webhook"""
        if not self.custom_webhook:
            return

        try:
            content = f"{title}\n{message}"
            payload = {
                "msgtype": "text",
                "text": {"content": content},
                # 兼容飞书
                "msg_type": "text",
                "content": {"text": content},
            }
            resp = requests.post(self.custom_webhook, json=payload, timeout=4.0)
            logger.info("自定义 Webhook 推送回执: %s", resp.status_code)
        except Exception as e:
            logger.warning("自定义 Webhook 推送异常: %s", e)

    def notify(self, title: str, message: str, is_urgent: bool = False) -> None:
        """统一广播通知"""
        self.play_sound(is_urgent=is_urgent)
        self.print_banner(title, message, is_urgent=is_urgent)
        self.send_bark(title, message, is_urgent=is_urgent)
        self.send_serverchan(title, message)
        self.send_custom_webhook(title, message)
