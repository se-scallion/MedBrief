# -*- coding: utf-8 -*-
"""
114 挂号平台底层 HTTP 客户端封装
封装 requests.Session，自动补齐 Headers、Cookie 鉴权、响应状态解析与异常转换
"""

import email.utils
import json
import logging
import time
from typing import Any, Dict, Optional, Tuple, Union
import requests

logger = logging.getLogger("guahao.client")

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
BASE_URL = "https://www.114yygh.com"


class GuahaoException(Exception):
    """114 挂号模块基础异常"""
    pass


class AuthException(GuahaoException):
    """会话失效或未登录异常"""
    pass


class CaptchaRequiredException(GuahaoException):
    """
    触发平台验证码/人机安全拦截异常
    【安全合规铁律】：严格不接入自动化破解验证码代码，一旦捕获此异常立即抛出并警报！
    """
    pass


class DuplicateOrderException(GuahaoException):
    """重复订单异常 (resCode: 8008)"""
    pass


class DutySoldOutException(GuahaoException):
    """号源已被抢光异常"""
    pass


class ApiRequestException(GuahaoException):
    """通用接口调用业务异常"""
    def __init__(self, res_code: int, msg: str, data: Any = None):
        super().__init__(f"114 API 业务错误 [{res_code}]: {msg}")
        self.res_code = res_code
        self.msg = msg
        self.data = data


class GuahaoClient:
    """114 平台专用 HTTP 客户端"""

    def __init__(
        self,
        cmi_user_ticket: str = "",
        cookie_str: str = "",
        timeout: float = 6.0,
        base_url: str = BASE_URL,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.cmi_user_ticket = cmi_user_ticket.strip()
        self.last_server_time: Optional[float] = None
        self.last_rtt: Optional[float] = None

        self.session = requests.Session()
        self._init_headers()
        self._init_cookies(cookie_str)

    def _init_headers(self) -> None:
        """初始化 114 官网请求头"""
        self.session.headers.update({
            "User-Agent": DEFAULT_UA,
            "Request-Source": "PC",
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json, text/plain, */*",
            "Referer": f"{self.base_url}/",
            "Origin": self.base_url,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        })
        if self.cmi_user_ticket:
            self.session.headers["cmi-user-ticket"] = self.cmi_user_ticket

    def _init_cookies(self, cookie_str: str) -> None:
        """填充 Cookie 凭据"""
        if self.cmi_user_ticket:
            self.session.cookies.set("cmi-user-ticket", self.cmi_user_ticket, domain=".114yygh.com")

        if cookie_str:
            for item in cookie_str.split(";"):
                item = item.strip()
                if not item or "=" not in item:
                    continue
                k, v = item.split("=", 1)
                self.session.cookies.set(k.strip(), v.strip(), domain=".114yygh.com")

    def set_ticket(self, ticket: str) -> None:
        """动态更新 cmi-user-ticket"""
        self.cmi_user_ticket = ticket.strip()
        self.session.headers["cmi-user-ticket"] = self.cmi_user_ticket
        self.session.cookies.set("cmi-user-ticket", self.cmi_user_ticket, domain=".114yygh.com")

    def _parse_server_date(self, date_header: Optional[str]) -> Optional[float]:
        """解析 HTTP Date 响应头为 UTC 时间戳"""
        if not date_header:
            return None
        try:
            parsed_tuple = email.utils.parsedate_to_datetime(date_header)
            return parsed_tuple.timestamp()
        except Exception as e:
            logger.debug("Failed to parse Date header '%s': %s", date_header, e)
            return None

    def request(
        self,
        method: str,
        path_or_url: str,
        json_data: Any = None,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        raw_response: bool = False,
    ) -> Union[Dict[str, Any], requests.Response]:
        """
        统一发送请求并处理 114 响应
        """
        url = path_or_url if path_or_url.startswith("http") else f"{self.base_url}/{path_or_url.lstrip('/')}"
        req_timeout = timeout if timeout is not None else self.timeout

        t_start = time.time()
        try:
            response = self.session.request(
                method=method.upper(),
                url=url,
                json=json_data,
                params=params,
                headers=headers,
                timeout=req_timeout,
            )
            t_end = time.time()
        except requests.RequestException as e:
            logger.error("HTTP request failed: %s %s, err: %s", method, url, e)
            raise GuahaoException(f"网络连接异常: {e}") from e

        # 记录 RTT 与服务器时间戳
        self.last_rtt = t_end - t_start
        srv_date = response.headers.get("Date")
        self.last_server_time = self._parse_server_date(srv_date)

        if raw_response:
            return response

        # HTTP 状态码校验
        if response.status_code != 200:
            raise GuahaoException(f"114 平台返回异常 HTTP 状态码: {response.status_code}, 内容: {response.text[:200]}")

        # JSON 解析
        try:
            body = response.json()
        except Exception as e:
            raise GuahaoException(f"114 平台返回非 JSON 响应: {response.text[:200]}") from e

        res_code = body.get("resCode")
        msg = body.get("msg") or body.get("message") or ""
        data = body.get("data")

        # 1. 验证码 / 人机风控拦截判定（严格报警，不自动破解）
        captcha_keywords = ("验证码", "滑块", "人机", "安全验证", "安全拦截", "行为验证", "图形验证")
        is_captcha = (
            res_code in (10001, 10002, 10003, 20001, 20002)
            or any(k in msg for k in captcha_keywords)
        )
        if is_captcha:
            logger.critical("触发 114 安全拦截/验证码需求: resCode=%s, msg=%s", res_code, msg)
            raise CaptchaRequiredException(f"触发 114 安全验证码拦截: {msg} (resCode: {res_code})")

        # 2. 会话登录态失效
        if res_code in (2001, 2002) or "未登录" in msg or "ticket失效" in msg or "登录超时" in msg:
            raise AuthException(f"114 会话失效，请更新 cmi-user-ticket: {msg} (resCode: {res_code})")

        # 3. 重复订单判定 (8008)
        # 根据业务要求：对 resCode == 8008 判定为成功（该号此前或并发中已下单成功，避免漏单）
        if res_code == 8008:
            logger.warning("114 返回 8008 (已存在重复预约单，视为抢号成功): %s", msg)
            return {
                "resCode": 8008,
                "msg": msg,
                "data": data or {},
                "is_duplicate_success": True,
            }

        # 4. 号源售罄
        if "已约满" in msg or "无号" in msg or "暂无号源" in msg:
            raise DutySoldOutException(f"号源已售罄: {msg}")

        # 5. 成功返回
        if res_code == 0:
            return body

        # 6. 其他未知错误
        raise ApiRequestException(res_code=res_code, msg=msg, data=data)

    def get(self, path: str, params: Optional[Dict[str, Any]] = None, **kwargs) -> Any:
        return self.request("GET", path, params=params, **kwargs)

    def post(self, path: str, json_data: Any = None, **kwargs) -> Any:
        return self.request("POST", path, json_data=json_data, **kwargs)
