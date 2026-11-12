# -*- coding: utf-8 -*-
"""
114 平台用户鉴权与就诊人模块
提供会话有效性探活 (is_login)、用户信息获取与就诊人/就诊卡列表解析
"""

import logging
from typing import Any, Dict, List, Optional, Tuple
from .client import AuthException, GuahaoClient, GuahaoException

logger = logging.getLogger("guahao.auth")


def mask_str(s: str, keep_start: int = 1, keep_end: int = 1) -> str:
    """脱敏工具函数"""
    if not s:
        return ""
    if len(s) <= keep_start + keep_end:
        return s[0] + "*" * (len(s) - 1)
    return s[:keep_start] + "*" * (len(s) - keep_start - keep_end) + s[-keep_end:]


def is_login(client: GuahaoClient) -> Tuple[bool, Dict[str, Any]]:
    """
    检查当前 cmi-user-ticket 是否有效
    调用 114 官方探活接口：/web/user/info
    @return (is_logged_in, user_info)
    """
    try:
        res = client.get("/web/user/info")
        data = res.get("data") or {}
        if data and ("uid" in data or "id" in data or "mobile" in data):
            return True, data
        return False, {}
    except (AuthException, GuahaoException) as e:
        logger.debug("is_login 探活未通过: %s", e)
        return False, {}
    except Exception as e:
        logger.error("is_login 探活异常: %s", e)
        return False, {}


def check_session(client: GuahaoClient) -> Dict[str, Any]:
    """
    强制校验会话有效性，若失效则直接抛出 AuthException，成功则输出脱敏摘要
    """
    ok, info = is_login(client)
    if not ok:
        raise AuthException("114 平台登录状态已失效，请重新从浏览器获取 cmi-user-ticket 并更新配置文件！")

    real_name = info.get("realName") or info.get("name") or "未实名"
    mobile = info.get("mobile") or info.get("phone") or ""
    uid = info.get("uid") or info.get("id") or ""

    summary = {
        "uid": uid,
        "real_name": real_name,
        "real_name_masked": mask_str(real_name, 1, 0),
        "mobile": mobile,
        "mobile_masked": mask_str(mobile, 3, 4),
        "raw": info,
    }
    logger.info("114 会话有效: 用户 %s (%s)", summary["real_name_masked"], summary["mobile_masked"])
    return summary


def get_patient_list(client: GuahaoClient) -> List[Dict[str, Any]]:
    """
    获取就诊人列表 (/web/user/patient/list)
    """
    try:
        res = client.get("/web/user/patient/list")
        data = res.get("data") or []
        patients = []
        for p in data:
            patients.append({
                "patient_id": str(p.get("id") or p.get("patientId") or ""),
                "name": p.get("name") or p.get("realName") or "",
                "id_card_masked": mask_str(p.get("idCardNo") or p.get("idCard") or "", 3, 4),
                "mobile_masked": mask_str(p.get("phone") or p.get("mobile") or "", 3, 4),
                "is_default": bool(p.get("isDefault")),
                "raw": p,
            })
        return patients
    except Exception as e:
        logger.warning("获取就诊人列表失败 (部分账号或阶段可能无此接口): %s", e)
        return []


def resolve_patient_and_card(
    client: GuahaoClient,
    target_patient_name: str = "",
    config_patient_id: str = "",
    config_card_id: str = "",
) -> Dict[str, str]:
    """
    自动解析并撮合目标就诊人 ID 与就诊卡 ID
    """
    patient_id = config_patient_id.strip()
    card_id = config_card_id.strip()

    if not patient_id and target_patient_name:
        patients = get_patient_list(client)
        for p in patients:
            if p["name"] == target_patient_name or target_patient_name in p["name"]:
                patient_id = p["patient_id"]
                logger.info("自动匹配到就诊人: %s (ID: %s)", p["name"], patient_id)
                break

    return {
        "patient_id": patient_id,
        "card_id": card_id,
        "patient_name": target_patient_name,
    }
