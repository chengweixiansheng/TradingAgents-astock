"""Prompt 包 —— 把「分析口径」从引擎里拆出来。

引擎（数据管线 / 多 agent 编排 / 反思闭环）是通用的；
**说什么、说到什么程度**由 prompt 包决定。本仓库只自带一个包：

- `RESEARCH_PACK`（默认，也是本仓库唯一自带的）——**市场与板块层面的观察与研判**：
  情绪档位、盘面总结、活跃题材方向及其依据与风险；
  个股一律只作**客观事实描述**（属于哪个题材、资金/技术是什么状态、有哪些风险），
  **不点名推荐个股、不给个股参与倾向、不给关注点位或买卖时机**。

需要别的口径，自己写一个包：新建 `~/.vibe-astock/prompts_local.py`，
在里面构造一个 `PromptPack` 实例并赋给模块级变量 `PACK`（也可用环境变量
`VIBE_ASTOCK_PROMPTS` 指向任意 .py 路径）。加载到的包会整体替换默认包。
该文件在本仓库之外，不随代码分发；写什么、怎么用、由此产生的责任，
由使用者自负，并请自行确认所在司法辖区对相关活动的资质要求。
"""

from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel

from . import schemas
from .deepdive import schemas as dd_schemas

_LOCAL_PACK_PATH = Path.home() / ".vibe-astock" / "prompts_local.py"


@dataclass(frozen=True)
class PromptPack:
    """一套完整的分析口径。引擎只认这个接口，不关心里面写了什么。"""

    name: str
    analyst_style: str            # 五个复盘分析师的语气/尺度
    analyst_len: str              # 篇幅约束
    judge_requirements: str       # 复盘裁判的产出要求（编号列表正文）
    focus_model: type[BaseModel]  # 复盘结论 schema
    focus_skeleton: str           # 给 JSON 模式的英文键骨架
    render_focus: Callable[[Any], str]
    chat_guidance: str = (
        "只做两件事：① 解释、展开、比较上面已经给出的结论与数据；② 讲清计算口径、"
        "证据来源、历史同类情况。个股一律只作客观陈述（题材归属、涨停梯队、龙虎榜席位等公开事实），"
        "不给参与倾向（能不能买/值不值得参与/谁更稳）、不给买卖点位或时机、不做品种推荐。"
        "上面没覆盖的就说没覆盖，别编。"
    )
    # 个股深挖（按需跑的单股 agent）的口径。⚠️ 与 chat_guidance 同理，**必须带默认值**：
    # 用户的本地包多半是在这几条字段加进来之前写的，不给默认值会让它构造 PromptPack 时
    # 因缺参报错 → 静默回退默认包（表现是"跑起来了但口径全变了"，最难发现）。
    deepdive_style: str = (
        "基于数据讲清楚这只标的当前是什么状态、依据是什么。"
        "只作客观描述与风险披露，不给参与倾向、不给买卖点位。"
    )
    deepdive_requirements: str = """1. 一句话概括这只标的当前的客观状态。
2. 题材归属与它和当前市场主线的关系。
3. 资金面状态（龙虎榜/量能/主力动向）。
4. 技术位置（所处区间、形态、连板情况）。
5. 需要披露的风险点。
6. 总结正反两方的核心分歧。
⚠️ 只做事实描述与风险披露：不给参与倾向（值得关注/回避之类）、不给关注点位或买卖时机。"""
    verdict_model: type[BaseModel] = dd_schemas.StockProfile   # 个股结论 schema
    verdict_skeleton: str = dd_schemas.PROFILE_SKELETON
    render_verdict: Callable[[Any], str] = dd_schemas.render_profile


RESEARCH_PACK = PromptPack(
    name="research",
    analyst_style=(
        "基于数据讲清楚今天盘面发生了什么、为什么，把依据摆出来。"
        "个股只作客观陈述（涨停梯队、龙虎榜席位、题材归属等公开事实），"
        "不点名推荐、不给参与倾向、不给买卖点位。"
    ),
    analyst_len="控制在 350 字内。",
    judge_requirements="""1. 判断当前市场情绪档位（冰点/修复/发酵/亢奋/退潮）。
2. 梳理 2-5 个当前活跃的题材/板块方向，每个含：支撑依据（情绪/资金/题材/龙头 哪几条）、以及该方向的风险与证伪信号。
3. 列出需警惕的风险信号。
4. 给出你对**市场所处阶段**的判断。
⚠️ 全程只做市场与板块层面的研判：不点名推荐个股、不给个股参与倾向、不给买卖点位或时机。""",
    focus_model=schemas.TomorrowFocus,
    focus_skeleton=schemas.FOCUS_SKELETON,
    render_focus=schemas.render_tomorrow_focus,
)


def _local_pack_path() -> Path | None:
    """本地 prompt 包路径：环境变量优先，其次 ~/.vibe-astock/prompts_local.py"""
    env = os.environ.get("VIBE_ASTOCK_PROMPTS", "").strip()
    if env.lower() in {"builtin", "default", "none"}:
        return None
    if env:
        return Path(env).expanduser()
    return _LOCAL_PACK_PATH if _LOCAL_PACK_PATH.is_file() else None


def load_pack() -> PromptPack:
    """加载 prompt 包：有本地包用本地的，用自带的 RESEARCH_PACK"""
    path = _local_pack_path()
    if path is None:
        return RESEARCH_PACK
    if not path.is_file():
        print(f"⚠️ prompt 包不存在，回退默认包：{path}")
        return RESEARCH_PACK
    # 启动日志明示：加载的是**可执行代码**，让人一眼看见这条边界
    print(f"⚙️ 加载本地 prompt 包（以进程权限执行，仅限可信文件）：{path}")
    mod_name = "vibe_astock_prompts_local"
    try:
        spec = importlib.util.spec_from_file_location(mod_name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"无法加载 {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(mod_name, None)   # 加载失败别留半截模块
            raise
        pack = getattr(module, "PACK", None)
        if not isinstance(pack, PromptPack):
            raise TypeError(f"{path} 里的 PACK 不是 PromptPack 实例")
    except Exception as exc:  # noqa: BLE001  口径加载失败要吵，但不能炸掉整个系统
        sys.modules.pop(mod_name, None)
        print(f"⚠️ prompt 包加载失败，回退默认包（{type(exc).__name__}: {exc}）")
        return RESEARCH_PACK
    print(f"ℹ️ 已加载本地 prompt 包：{pack.name}（{path}）")
    return pack


PACK = load_pack()
