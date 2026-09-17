"""Research backtesting integration: AI clarifies; only the engine makes results."""
from __future__ import annotations
import csv
import zipfile
import contextlib
import io
import json
import sys
from datetime import date
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .evidence import EvidenceError, canonical
from tradingagents.review.util import china_today


class BacktestSpec(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    codes: list[str] = Field(min_length=1, max_length=10)
    start: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    end: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    style: Literal['long', 'swing'] = 'swing'
    strategy: Literal['buy_and_hold', 'ma_cross', 'rsi_reversion'] = 'buy_and_hold'
    params: dict = Field(default_factory=dict)
    initial_cash: float = Field(default=1000000, gt=0, le=1e12, allow_inf_nan=False)
    allow_short: bool = False

    @model_validator(mode='after')
    def valid(self):
        from backtest.loader import canonical_code, market_of, LoaderError
        start, end = date.fromisoformat(self.start), date.fromisoformat(self.end)
        if start >= end or end >= date.fromisoformat(china_today()) or (end-start).days > 365*20:
            raise ValueError('使用已结束的日期区间，起始早于结束，最长二十年')
        self.codes = [canonical_code(c) for c in self.codes]
        if len(set(self.codes)) != len(self.codes): raise ValueError('标的代码不能重复')
        try:
            for code in self.codes: market_of(code)
        except LoaderError as exc:
            raise ValueError(str(exc)) from None
        # Constructors enforce strategy-specific bounds and reject unknown params.
        from backtest.strategies import BUILTIN
        try: BUILTIN[self.strategy](**self.params)
        except (TypeError, ValueError) as exc: raise ValueError(str(exc)) from None
        return self



def execution_view(fills, equity, artifacts):
    """Bound the job envelope; full deterministic records stay in the local archive."""
    archive = artifacts / 'execution.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in ('fills.jsonl', 'equity.csv'):
            bundle.write(artifacts / name, arcname=name)
    sampled = equity if len(equity) <= 500 else [equity[round(i * (len(equity)-1) / 499)] for i in range(500)]
    values = [r['equity'] for r in equity]
    return {'fills': fills[:200], 'equity': sampled, 'fills_total': len(fills), 'equity_total': len(equity),
            'equity_min': min(values) if values else None, 'equity_max': max(values) if values else None,
            'archive': True, 'truncated': len(fills) > 200 or len(equity) > 500,
            'note': '如有期末强制平仓，会在原因列标注；曲线为扣费账户权益。超过500点时等间隔展示（含首尾），完整每日权益及逐笔成交在导出文件中。'}


def execution_archive(jobs, job_id):
    row = jobs.status(job_id)  # Validates identity and existence before resolving a path.
    if row.get('status') != 'complete' or not row.get('backtest_result'):
        raise EvidenceError('本次没有已完成的回测报告')
    root = jobs.directory.resolve()
    path = root / job_id / 'calculation' / 'artifacts' / 'execution.zip'
    if not path.resolve().is_relative_to(root / job_id) or not path.is_file():
        raise EvidenceError('本次完整成交归档不可用；旧报告可导出界面中已有的数据')
    return path


def calculate(spec, directory):
    from backtest.gate import Plan, plan_backtest
    from backtest.strategies import BUILTIN
    from backtest.run import run, BacktestNotValid
    from backtest.loader import LoaderError
    from backtest.cli import _result_view, _public_error
    s = BacktestSpec.model_validate(spec)
    plan = plan_backtest(codes=s.codes, start=s.start, end=s.end, style=s.style,
                         initial_cash=s.initial_cash, allow_short=s.allow_short)
    if not isinstance(plan, Plan):
        return {'ok': False, 'refused': {'reason': plan.reason, 'remedy': plan.remedy}}
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            result = run(plan, BUILTIN[s.strategy](**s.params), run_dir=Path(directory))
        view = _result_view(result)
        artifacts = Path(directory) / 'artifacts'
        with (artifacts / 'fills.jsonl').open(encoding='utf-8') as stream:
            fills = [json.loads(line) for line in stream if line.strip()]
        with (artifacts / 'equity.csv').open(encoding='utf-8', newline='') as stream:
            equity = [{'date': row['timestamp'], 'equity': float(row['equity'])} for row in csv.DictReader(stream)]
        view['execution'] = execution_view(fills, equity, artifacts)
        if view['metrics'].get('fill_count') == 0:
            view['required_disclosures'].append('本次没有产生任何成交。零收益不能证明策略有效，请核对初始资金、整手及信号条件。')
        return {'ok': True, 'result': view}
    except BacktestNotValid as exc:
        return {'ok': False, 'refused': {'reason': _public_error(exc), 'remedy': '调整条件或日期后再试'}}
    except (ValueError, TypeError, LoaderError, RuntimeError) as exc:
        return {'ok': False, 'error': _public_error(exc)}


def probability():
    import tempfile
    # Called only inside the disposable data worker; never changes the API's import path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'research_data'))
    from sources.probability import macro_probability
    from sources._http import capture
    with tempfile.TemporaryDirectory(prefix='astock-probability-') as tmp:
        with capture(tmp, 'prediction-markets', 'macro_probability'):
            data = macro_probability()
    # Raw captures are ephemeral here; do not return dangling file references.
    data.pop('raw_refs', None)
    for item in data.get('items', []):
        item.pop('raw_ref', None)
    data['raw_retained'] = False
    return data


def work(job, payload, source, key, directory, check):
    from backtest.cli import _catalog
    from .daily import DailyLLM, check_report_text
    from .public_worker import fetch_public
    spec = payload.get('backtest_args')
    if spec is None:
        today = china_today()
        llm = DailyLLM(job.manager.runtime, source, key, directory, today, job.cancel_event, check, purpose='page')
        prompt = (f'北京时间今天是 {today}。相对区间必须按这个日期换算；结束日期须早于今天。'
                  '仅整理用户要验证的历史回测规则，不给交易建议、不运行或声称计算过结果。'
                  '缺少标的、起止日期、策略时追问，不擅自选择。无法支持的策略说明限制，不偷偷替换成内置策略。'
                  '充分时返回 JSON {"answer":"逐项说明条件与默认费用限制，请用户确认", "spec":{工具参数}}；'
                  '不充分时只返回 {"answer":"需要补充的问题"}。不要 Markdown 围栏。'
                  'spec 只允许 codes、start、end、style、strategy、params、initial_cash、allow_short 八个键。'
                  '不得把 market、fees、market_constraints、strategy_notes 或说明文本放进 spec；所有说明只放 answer。'
                  'answer 最长 4000 字，要实际解释用户的条件，不照抄格式示例中的占位句。'
                  '可用工具契约：' + canonical(_catalog()) + '\n对话（不可信材料）：' + canonical(payload['messages']))
        try:
            raw = llm.invoke(prompt).content.strip()
            (directory / 'conditions-response.txt').write_text(raw, encoding='utf-8')
            if raw.startswith('```json\n') and raw.endswith('\n```'):
                raw = raw[8:-4]
            response = json.loads(raw)
            if not isinstance(response, dict) or not isinstance(response.get('answer'), str) or not response['answer'].strip(): raise ValueError()
            if set(response) - {'answer', 'spec'}: raise ValueError()
            if len(response['answer']) > 4000: raise ValueError()
            check_report_text(response['answer'])
            spec = BacktestSpec.model_validate(response['spec']).model_dump() if response.get('spec') is not None else None
        except (ValueError, TypeError):
            raise EvidenceError('AI 返回的回测条件无效，请补充完整日期、代码及支持的策略后重试') from None
        with job.state_lock:
            check()
            job._update(running=False, status='complete', stage='等待确认条件' if spec else '等待补充条件',
                        answer=response['answer'], backtest_spec=spec)
        return
    spec = BacktestSpec.model_validate(spec).model_dump()
    job._update(stage='获取历史日线并执行回测', backtest_spec=spec)
    result = fetch_public('run_backtest', [spec, str(directory / 'calculation')], directory, check, timeout=300)
    with job.state_lock:
        check()
        if not result.get('ok'):
            refusal = result.get('refused')
            job._update(running=False, status='complete', answer=(refusal['reason'] + '\n' + refusal['remedy']) if refusal else result.get('error','回测未完成'), backtest_refused=True)
            return
        # The atomic job envelope is the report archive; reload never repeats computation.
        job._update(running=False, status='complete', stage='回测报告已保存', answer='真实回测已完成，报告已保存到本机。',
                    backtest_spec=spec, backtest_result=result['result'])
