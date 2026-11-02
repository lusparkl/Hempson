import { useRef, useState, type FormEvent } from 'react';
import { useShop } from '../App';
import { api, errText, moneyList, useLoad } from '../api';
import { Badge, Button, Drawer, HeaderActions, Icon, Input, useToast, type Tone } from '../ui';

type Variant = { variantId: string; sku: string; options: Record<string, string>; priceMinor: number; stock: number; active: boolean };
type Product = { productId: string; name: string; priceMinor: number; currency: string; active: boolean; variants: Variant[] };
type ImportResult = {
  dryRun: boolean;
  applied: boolean;
  rows: number;
  created: { products: number; variants: number };
  updated: { products: number; variants: number };
  errors: { line: number; message: string }[];
  warnings: string[];
};
type Source = { path: string; label: string; body: { csv: string } | { url: string } };
type StockFilter = 'all' | 'low' | 'out';

const level = (n: number, active: boolean): [string, Tone, StockFilter | 'ok'] =>
  !active ? ['Приховано', 'neutral', 'ok'] : n === 0 ? ['Немає', 'danger', 'out'] : n < 5 ? ['Мало', 'warning', 'low'] : ['В наявності', 'success', 'ok'];

export function Catalog() {
  const { shop, params } = useShop();
  const base = `/v1/shops/${shop.shopId}/products`;
  const owner = shop.role === 'owner';
  const say = useToast();
  const [q, setQ] = useState('');
  const [sf, setSf] = useState<StockFilter>(params.stock ?? 'all');
  const [drawer, setDrawer] = useState<'' | 'import' | 'new'>('');
  const list = useLoad(() => api<{ total: number; items: Product[] }>('GET', `${base}?limit=200${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`), [base, q]);

  const all = (list.data?.items ?? []).flatMap((p) => p.variants.map((v) => ({ p, v, lv: level(v.stock, p.active && v.active) })));
  const rows = all.filter((r) => sf === 'all' || r.lv[2] === sf);

  const setStock = async (p: Product, v: Variant, n: number) => {
    if (!Number.isInteger(n) || n < 0 || n === v.stock) return;
    try {
      await api('POST', `${base}/${p.productId}/variants/${v.variantId}/stock`, { set: n });
      await list.reload();
    } catch (e) {
      say(errText(e), true);
    }
  };

  return (
    <div className="page">
      {owner && (
        <HeaderActions>
          <Button variant="secondary" size="sm" icon="upload" onClick={() => setDrawer('import')}>
            Імпорт
          </Button>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setDrawer('new')}>
            Новий товар
          </Button>
        </HeaderActions>
      )}
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Пошук за назвою або артикулом" aria-label="Пошук товару" />
        </div>
        <div className="pills">
          {(
            [
              ['all', 'Усі'],
              ['low', 'Мало'],
              ['out', 'Немає'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className="pill" aria-pressed={sf === k} onClick={() => setSf(k)}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 13 }} className="subtle">
          {rows.length} з {all.length} позицій
        </div>
      </div>
      {list.error && <div className="err">{list.error}</div>}
      <div className="panel clip" style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: 760 }}>
          <div className="thead catalog-cols">
            <span>Товар</span>
            <span>Варіант</span>
            <span>Ціна</span>
            <span>Залишок</span>
            <span>Статус</span>
          </div>
          {rows.map(({ p, v, lv }) => (
            <div key={v.variantId} className={`prow${v.stock === 0 ? ' out' : ''}`}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                <span className="ptile">
                  <Icon name="package" size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 500, color: 'var(--ink-900)' }}>
                    {p.name}
                  </div>
                  <div className="mono subtle" style={{ fontSize: 12 }}>
                    {v.sku}
                  </div>
                </div>
              </div>
              <span className="muted" style={{ fontSize: 14 }}>
                {Object.values(v.options).join(' / ') || '—'}
              </span>
              <span style={{ color: 'var(--ink-900)' }}>{moneyList(v.priceMinor, p.currency)}</span>
              <Stepper value={v.stock} label={v.sku} onSet={(n) => void setStock(p, v, n)} />
              <span>
                <Badge tone={lv[1]}>{lv[0]}</Badge>
              </span>
            </div>
          ))}
          {list.data && rows.length === 0 && <div className="panel-empty" style={{ padding: '48px 20px' }}>{all.length ? 'Нічого не знайдено' : 'Товарів ще немає. Додайте товар або імпортуйте каталог.'}</div>}
        </div>
      </div>
      {drawer === 'import' && <ImportDrawer base={base} onClose={() => setDrawer('')} onDone={list.reload} />}
      {drawer === 'new' && <NewDrawer base={base} currency={shop.defaultCurrency} onClose={() => setDrawer('')} onDone={list.reload} />}
    </div>
  );
}

/** − value + ; the value is also editable for big changes (set on blur or Enter). */
function Stepper({ value, label, onSet }: { value: number; label: string; onSet: (n: number) => void }) {
  return (
    <div className="stepper">
      <button onClick={() => onSet(Math.max(0, value - 1))} aria-label={`Менше: ${label}`} disabled={value === 0}>
        −
      </button>
      <input
        key={value}
        type="number"
        min={0}
        defaultValue={value}
        aria-label={`Залишок ${label}`}
        onBlur={(e) => onSet(Number(e.target.value))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button onClick={() => onSet(value + 1)} aria-label={`Більше: ${label}`}>
        +
      </button>
    </div>
  );
}

/** Pick or drop a CSV, or paste a Google Sheets link; a dry run previews, then "Імпортувати" applies. */
function ImportDrawer({ base, onClose, onDone }: { base: string; onClose: () => void; onDone: () => Promise<void> }) {
  const say = useToast();
  const [src, setSrc] = useState<Source | null>(null);
  const [sheet, setSheet] = useState('');
  const [res, setRes] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const send = async (s: Source, dryRun: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<ImportResult>('POST', s.path, { ...s.body, dryRun });
      setRes(r);
      if (r.applied) {
        say('Каталог імпортовано');
        await onDone();
        onClose();
      }
    } catch (e) {
      setRes(null);
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = async (f: File | undefined) => {
    setRes(null);
    if (!f) return;
    const s = { path: `${base}/import`, label: f.name, body: { csv: await f.text() } };
    setSrc(s);
    await send(s, true);
  };
  const fromSheet = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!sheet.trim()) return;
    setRes(null);
    const s = { path: `${base}/import-sheet`, label: 'Google Sheets', body: { url: sheet.trim() } };
    setSrc(s);
    await send(s, true);
  };
  const ready = src && res && !res.applied && res.errors.length === 0;

  return (
    <Drawer
      title="Імпорт з CSV або Google Sheets"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            Скасувати
          </Button>
          {ready ? (
            <Button variant="primary" size="md" disabled={busy} onClick={() => void send(src, false)}>
              Імпортувати
            </Button>
          ) : (
            <Button variant="primary" size="md" disabled={busy || !sheet.trim()} onClick={() => void fromSheet()}>
              Переглянути
            </Button>
          )}
        </>
      }
    >
      <div
        className="drop"
        data-over={over ? '' : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void pick(e.dataTransfer.files[0]);
        }}
      >
        <span style={{ color: 'var(--brand-600)', display: 'flex' }}>
          <Icon name="file-spreadsheet" size={28} />
        </span>
        <div style={{ fontWeight: 500, color: 'var(--ink-900)' }}>Перетягніть CSV-файл сюди</div>
        <div style={{ fontSize: 13 }} className="subtle">
          або
        </div>
        <Button variant="secondary" size="sm" onClick={() => file.current?.click()}>
          Обрати файл
        </Button>
        <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => void pick(e.target.files?.[0])} aria-label="CSV файл" />
      </div>
      <div className="or">або посилання</div>
      <form onSubmit={(e) => void fromSheet(e)}>
        <Input label="Google Sheets" type="url" value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
      </form>
      <div style={{ fontSize: 13, lineHeight: 1.55 }} className="subtle">
        Таблиця має бути відкрита за посиланням («Усі, хто має посилання» — читач). Береться вкладка з посилання; при імпорті таблиця читається ще раз.
      </div>
      {err && <div className="err">{err}</div>}
      {res && src && (
        <div className="panel" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14 }}>
          <strong style={{ fontWeight: 500, color: 'var(--ink-900)' }}>{src.label}</strong>
          <span className="muted">
            Рядків {res.rows}; нових товарів {res.created.products}, нових варіантів {res.created.variants}; оновлено товарів {res.updated.products}, варіантів {res.updated.variants}.
          </span>
          <span>{res.applied ? 'Імпортовано.' : res.errors.length ? 'Не імпортовано: виправте помилки.' : 'Це перегляд, нічого не записано.'}</span>
          {res.warnings.map((w) => (
            <span key={w} className="subtle">
              {w}
            </span>
          ))}
          {res.errors.slice(0, 50).map((e) => (
            <span key={`${e.line}-${e.message}`} className="err">
              Рядок {e.line}: {e.message}
            </span>
          ))}
          {res.errors.length > 50 && <span className="subtle">…і ще {res.errors.length - 50} помилок.</span>}
        </div>
      )}
      <div className="howto">
        <div style={{ fontWeight: 500, color: 'var(--brand-800)', fontSize: 14 }}>Як працює імпорт</div>
        <div style={{ fontSize: 13, color: 'var(--ink-700)', lineHeight: 1.6 }}>
          Обов’язкова колонка — <span className="mono">sku</span>. Додаткові: name, price, stock, description, active, group, options (size=M|color=red), variant_price.
          <br />
          Артикул, що вже є, оновлюється. Порожні клітинки нічого не змінюють. Залишок встановлюється, а не додається. Усе або нічого.
        </div>
      </div>
    </Drawer>
  );
}

function NewDrawer({ base, currency, onClose, onDone }: { base: string; currency: string; onClose: () => void; onDone: () => Promise<void> }) {
  const say = useToast();
  const [err, setErr] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const el = form.current!;
    if (!el.reportValidity()) return;
    const f = new FormData(el);
    try {
      await api('POST', base, {
        name: String(f.get('name')),
        priceMinor: Math.round(Number(String(f.get('price')).replace(',', '.')) * 100),
        currency,
        sku: String(f.get('sku')),
        stock: Number(f.get('stock') || 0),
      });
      say('Товар додано до каталогу');
      await onDone();
      onClose();
    } catch (x) {
      setErr(errText(x));
    }
  };
  return (
    <Drawer
      title="Новий товар"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            Скасувати
          </Button>
          <Button variant="primary" size="md" onClick={() => void submit()}>
            Додати товар
          </Button>
        </>
      }
    >
      <form ref={form} onSubmit={(e) => void submit(e)} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Input label="Назва" name="name" required maxLength={200} placeholder="Лляна сумка" />
        <div className="grid2">
          <Input label={`Ціна, ${currency}`} name="price" required inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,2})?" placeholder="640" />
          <Input label="Артикул (SKU)" name="sku" required maxLength={64} pattern="[A-Za-z0-9._\-]+" placeholder="BAG-LN-01" />
        </div>
        <Input label="Залишок" name="stock" type="number" min={0} defaultValue={0} />
        {err && <div className="err">{err}</div>}
        <div style={{ fontSize: 13, lineHeight: 1.55 }} className="subtle">
          Варіанти (розмір, колір) та опис поки додаються через API або імпорт.
        </div>
        <button type="submit" hidden />
      </form>
    </Drawer>
  );
}
