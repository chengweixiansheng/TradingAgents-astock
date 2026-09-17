"""LLM 异常分类 —— 决定「该降级」还是「该冒泡」"""

from __future__ import annotations

# 配置类错误的文字特征。仅作**兜底** —— 类型能判出来就不看字符串。
# 大小写不敏感匹配。
_CONFIG_MARKERS = (
    "invalid api key",
    "incorrect api key",
    "invalid_api_key",
    "invalid_key",
    "no api key",
    "api key not",
    "unauthorized",
    "authenticationerror",
    "oauth access token has expired",   # 本机 claude CLI 登录过期
    "re-authenticate",
    "未检测到",                          # cli_runtime：CLI 没装 / 不在 PATH
    "找不到 mimo 凭据文件",
    "mimo_api_key 未设置",
    "model_not_found",
    "does not exist or you do not have access",
)


class LlmConfigError(RuntimeError):
    """配置/凭据错误的统一出口 —— 一路抛到任务层，变成用户看得见的 error。"""


def _openai_config_types() -> tuple[type, ...]:
    """openai SDK 里属于「配置错误」的异常类型（装不上就返回空元组）。"""
    try:
        import openai
    except Exception:  # noqa: BLE001  没装 openai 也要能用（纯 CLI 后端）
        return ()
    names = ("AuthenticationError", "PermissionDeniedError", "NotFoundError")
    return tuple(t for t in (getattr(openai, n, None) for n in names) if isinstance(t, type))


def is_config_error(exc: BaseException) -> bool:
    """这个异常是「配置/凭据错误」吗 —— 是就该冒泡，别降级。"""
    if isinstance(exc, LlmConfigError):
        return True     # 已经判定过的，别在下游被重新分类成"暂时性"又给降级了
    types = _openai_config_types()
    if types and isinstance(exc, types):
        return True
    # 有些包装层会把原始异常塞进 __cause__ / __context__
    for inner in (getattr(exc, "__cause__", None), getattr(exc, "__context__", None)):
        if inner is not None and inner is not exc and types and isinstance(inner, types):
            return True
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(m in text for m in _CONFIG_MARKERS)


def raise_if_config_error(exc: BaseException, where: str) -> None:
    """节点里 `except` 到异常后**第一件事**调它：是配置错误就抛出去，别降级。

    `where` 写节点名，用户看到的报错里会带上（知道是哪一步先撞上的）。
    """
    if is_config_error(exc):
        raise LlmConfigError(
            f"{where}：模型调用未通过鉴权／配置有误（{type(exc).__name__}: {str(exc)[:200]}）。"
            f"请检查 API key，或用 VIBE_LLM_CLI 走本机已登录的 CLI 订阅。"
        ) from exc
