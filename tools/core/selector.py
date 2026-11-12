# -*- coding: utf-8 -*-
"""
医生撮合引擎 (DoctorSelector)
按用户配置的目标医生优先级队列实施撮合，支持上下午时段过滤、智能替补策略与模糊匹配
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("guahao.selector")


class DoctorSelector:
    """智能医生与号源撮合引擎"""

    def __init__(
        self,
        target_doctors: Optional[List[str]] = None,
        duty_time_pref: int = 0,
        allow_substitute: bool = False,
    ):
        """
        @param target_doctors: 目标医生优先级列表，按索引由前到后优先级递减
        @param duty_time_pref: 时段偏好 (0: 不限, 1: 上午, 2: 下午)
        @param allow_substitute: 若目标医生无号，是否允许撮合替补医生
        """
        self.target_doctors = [d.strip() for d in (target_doctors or []) if d and d.strip()]
        self.duty_time_pref = duty_time_pref
        self.allow_substitute = allow_substitute

    def filter_by_duty_time(self, duty_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """按上下午时段偏好过滤"""
        if self.duty_time_pref in (1, 2):
            return [d for d in duty_list if d.get("duty_time") in (self.duty_time_pref, 0)]
        return duty_list

    def filter_available_only(self, duty_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """仅保留尚有余号的排班项"""
        available = []
        for d in duty_list:
            remain = d.get("remain_available", 0)
            status = str(d.get("status") or "").upper()
            if remain > 0 or status in ("AVAILABLE", "HAS_VACANCY"):
                available.append(d)
        return available

    def match(
        self,
        duty_list: List[Dict[str, Any]],
        custom_targets: Optional[List[str]] = None,
        custom_duty_time: Optional[int] = None,
        custom_allow_substitute: Optional[bool] = None,
    ) -> Tuple[Optional[Dict[str, Any]], int, bool]:
        """
        核心撮合算法：
        1. 过滤时段与售罄项
        2. 按 target_doctors 优先级队列逐项匹配 (优先级 0 > 1 > 2 ...)
        3. 若未命中目标且允许替补，则按最优策略选取替补号源
        @return (matched_duty_item, priority_rank, is_substitute)
                若未撮合到任何号，返回 (None, -1, False)
        """
        targets = custom_targets if custom_targets is not None else self.target_doctors
        duty_pref = custom_duty_time if custom_duty_time is not None else self.duty_time_pref
        allow_sub = custom_allow_substitute if custom_allow_substitute is not None else self.allow_substitute

        # 1. 时段筛选
        if duty_pref in (1, 2):
            candidates = [d for d in duty_list if d.get("duty_time") in (duty_pref, 0)]
        else:
            candidates = list(duty_list)

        # 2. 余号筛选
        available = [
            d for d in candidates
            if d.get("remain_available", 0) > 0 or str(d.get("status", "")).upper() in ("AVAILABLE", "HAS_VACANCY")
        ]

        if not available:
            logger.info("当前时段无可预约余号")
            return None, -1, False

        # 3. 若未配置目标医生，或目标医生包含通配符 "*"，直接取第一个有号的
        if not targets or "*" in targets:
            best = available[0]
            logger.info("通配/默认撮合成功: %s (%s)", best.get("doctor_name"), best.get("doctor_title"))
            return best, 0, False

        # 4. 按优先级队列顺序匹配
        for rank, target in enumerate(targets):
            t_clean = target.strip()
            if not t_clean:
                continue

            for item in available:
                doc_name = str(item.get("doctor_name", "")).strip()
                doc_title = str(item.get("doctor_title", "")).strip()

                # 精确匹配医生姓名
                if doc_name == t_clean:
                    logger.info("精确命中目标医生 [#%d]: %s (%s)", rank + 1, doc_name, doc_title)
                    return item, rank, False

                # 模糊/子串匹配（例如 target 配置了 "江倩"，item 可能是 "江倩(特需)"）
                if t_clean in doc_name or doc_name in t_clean:
                    logger.info("子串命中目标医生 [#%d]: %s (匹配目标: %s)", rank + 1, doc_name, t_clean)
                    return item, rank, False

                # 职称/级别匹配（例如 target 配置了 "知名专家"，item 职称也是 "知名专家"）
                if t_clean in doc_title or doc_title in t_clean:
                    logger.info("职称命中目标专家 [#%d]: %s - %s", rank + 1, doc_name, doc_title)
                    return item, rank, False

        # 5. 目标医生全无号，根据策略判断是否替补
        if allow_sub and available:
            substitute = available[0]
            logger.warning(
                "目标医生均无号，启用替补策略锁定: %s (%s, 挂号费: %s)",
                substitute.get("doctor_name"),
                substitute.get("doctor_title"),
                substitute.get("fee"),
            )
            return substitute, 999, True

        logger.info("未撮合到目标医生排班，且未开启替补策略")
        return None, -1, False
