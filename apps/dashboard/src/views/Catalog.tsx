import { useState, type FormEvent } from 'react';
import { api, errText, money, useLoad, type Shop } from '../api';

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

/** Pick a CSV, preview with a dry run, then apply. The server decides; nothing is written until "Імпортувати". */
function ImportCsv({ base, onDone }: { base: string; onDone: () => Promise<void> }) {
  const [csv, setCsv] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [res, setRes] = useState<ImportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (text: string, dryRun: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<ImportResult>('POST', `${base}/import`, { csv: text, dryRun });
      setRes(r);
      if (r.applied) {
        setCsv(null);
        await onDone();
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
    setErr(null);
    if (!f) return setCsv(null);
    const text = await f.text();
    setName(f.name);
    setCsv(text);
    await send(text, true);
  };

  return (
    <div className="card">
      <h2>Імпорт з CSV</h2>
      <p className="muted">
        Колонки: sku (обов'язково), name, price, stock, description, active, group, options (size=M|color=red), variant_price. Артикул, що вже є, оновлюється; порожні клітинки нічого не змінюють; залишок
        встановлюється, а не додається. Усе або нічого.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} aria-label="CSV файл" />
      {err && <p className="error">{err}</p>}
      {res && (
        <div>
          <p>
            {name}: рядків {res.rows}; нових товарів {res.created.products}, нових варіантів {res.created.variants}; оновлено товарів {res.updated.products}, варіантів {res.updated.variants}.
            {res.applied ? ' Імпортовано.' : res.errors.length ? ' Не імпортовано.' : ' Це перегляд, нічого не записано.'}
          </p>
          {res.warnings.map((w) => (
            <p key={w} className="muted">{w}</p>
          ))}
          {res.errors.slice(0, 50).map((e) => (
            <p key={`${e.line}-${e.message}`} className="error">Рядок {e.line}: {e.message}</p>
          ))}
          {res.errors.length > 50 && <p className="muted">…і ще {res.errors.length - 50} помилок.</p>}
        </div>
      )}
      {csv && res && !res.applied && res.errors.length === 0 && (
        <button type="button" disabled={busy} onClick={() => void send(csv, false)}>Імпортувати</button>
      )}
    </div>
  );
}

export function Catalog({ shop }: { shop: Shop }) {
  const base = `/v1/shops/${shop.shopId}/products`;
  const [q, setQ] = useState('');
  const list = useLoad(() => api<{ total: number; items: Product[] }>('GET', `${base}?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}`), [shop.shopId, q]);
  const [err, setErr] = useState<string | null>(null);
  const owner = shop.role === 'owner';

  const setStock = async (p: Product, v: Variant, value: string) => {
    setErr(null);
    try {
      await api('POST', `${base}/${p.productId}/variants/${v.variantId}/stock`, { set: Number(value) });
      await list.reload();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setErr(null);
    try {
      await api('POST', base, {
        name: String(f.get('name')),
        priceMinor: Math.round(Number(f.get('price')) * 100),
        currency: shop.defaultCurrency,
        sku: String(f.get('sku')),
        stock: Number(f.get('stock') || 0),
      });
      form.reset();
      await list.reload();
    } catch (x) {
      setErr(errText(x));
    }
  };

  return (
    <>
      <input type="search" placeholder="Пошук товару" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <p className="error">{err}</p>}
      {list.error && <p className="error">{list.error}</p>}
      <table>
        <thead>
          <tr><th>Товар</th><th>Ціна</th><th>Артикул</th><th>Варіант</th><th>Залишок</th></tr>
        </thead>
        <tbody>
          {list.data?.items.flatMap((p) =>
            p.variants.map((v, i) => (
              <tr key={v.variantId} className={p.active && v.active ? '' : 'muted'}>
                <td>{i === 0 ? p.name : ''}</td>
                <td>{money(v.priceMinor, p.currency)}</td>
                <td>{v.sku}</td>
                <td>{Object.values(v.options).join(' / ')}</td>
                <td>
                  <input
                    type="number"
                    min={0}
                    defaultValue={v.stock}
                    key={`${v.variantId}-${v.stock}`}
                    onBlur={(e) => e.target.value !== String(v.stock) && void setStock(p, v, e.target.value)}
                    aria-label={`Залишок ${v.sku}`}
                  />
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <p className="muted">Товарів немає.</p>}
      {owner && <ImportCsv base={base} onDone={list.reload} />}
      {owner && (
        <form className="card" onSubmit={create}>
          <h2>Новий товар</h2>
          <label>Назва <input name="name" required maxLength={200} /></label>
          <label>Ціна, {shop.defaultCurrency} <input name="price" type="number" min={0} step="0.01" required /></label>
          <label>Артикул (SKU) <input name="sku" required maxLength={64} pattern="[A-Za-z0-9._\-]+" /></label>
          <label>Залишок <input name="stock" type="number" min={0} defaultValue={0} /></label>
          <button type="submit">Додати</button>
          <p className="muted">Варіанти (розмір, колір) та опис поки додаються через API.</p>
        </form>
      )}
    </>
  );
}
