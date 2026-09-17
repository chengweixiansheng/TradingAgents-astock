import { Portfolio } from './Portfolio';
import { Watchlist } from './Watchlist';
import { PageHeader } from '@/components/ui/PageHeader';
export function MyStocks() {
  return <div className="space-y-8"><PageHeader title="持仓自选" subtitle="上方查看持仓，下方管理自选；移出自选不会删除持仓或成交记录。" />
    <section aria-label="持仓"><Portfolio embedded /></section>
    <section aria-label="自选" className="border-t border-border pt-8"><Watchlist embedded /></section>
  </div>;
}
