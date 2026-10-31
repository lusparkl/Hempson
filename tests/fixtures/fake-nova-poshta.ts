// Fake Nova Poshta JSON API 2.0. Method names, parameters and response shapes are written from NP's public API
// documentation (not captured from a live key).
import type { LlmStep } from './scripted-llm';

export const NP_KEY = '0123456789abcdef0123456789abcdef';
export const NP = {
  kyivRef: '8d5a980d-391c-11dd-90d9-001a92567626',
  lvivRef: 'db5c88f5-391c-11dd-90d9-001a92567626',
  branch5Ref: '1ec09d88-e1c2-11e3-8c4a-0050568002cf',
  branch12Ref: '7b422fc5-e1b8-11e3-8c4a-0050568002cf',
  lvivBranchRef: '16922830-e1c2-11e3-8c4a-0050568002cf',
  senderRef: '6e9acced-d072-11e3-95eb-0050568046cd',
  senderContactRef: 'b4e74a1c-c1d5-11e5-9be7-005056887b8d',
};

type Call = { calledMethod: string; modelName: string; apiKey: string; props: Record<string, any> };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
export const npOk = (data: unknown[]) => json({ success: true, data, errors: [], warnings: [], info: [], messageCodes: [], errorCodes: [], warningCodes: [], infoCodes: [] });
export const npErr = (errors: string[], errorCodes: string[] = []) => json({ success: false, data: [], errors, warnings: [], info: [], messageCodes: [], errorCodes, warningCodes: [], infoCodes: [] });

const CITIES = [
  { Ref: NP.kyivRef, Description: 'Київ', DescriptionRu: 'Киев', AreaDescription: 'Київська', CityID: '4' },
  { Ref: NP.lvivRef, Description: 'Львів', DescriptionRu: 'Львов', AreaDescription: 'Львівська', CityID: '2' },
];
const BRANCHES = [
  { Ref: NP.branch5Ref, CityRef: NP.kyivRef, Number: '5', Description: 'Відділення №5 (до 30 кг): вул. Федорова, 32', WarehouseStatus: 'Working' },
  { Ref: NP.branch12Ref, CityRef: NP.kyivRef, Number: '12', Description: 'Відділення №12 (до 30 кг): вул. Гончара, 33', WarehouseStatus: 'Working' },
  { Ref: 'closed-branch-ref', CityRef: NP.kyivRef, Number: '99', Description: 'Відділення №99: тимчасово не працює', WarehouseStatus: 'Closed' },
  { Ref: NP.lvivBranchRef, CityRef: NP.lvivRef, Number: '1', Description: 'Відділення №1: вул. Городоцька, 355', WarehouseStatus: 'Working' },
];

/** A handler per `calledMethod`; override one to simulate failures. `statuses` maps TTN to tracking status code. */
export function fakeNovaPoshta() {
  let ttnSeq = 20450000000000;
  const np = {
    calls: [] as Call[],
    statuses: new Map<string, { code: string; text: string }>(),
    validKeys: new Set([NP_KEY]),
    handlers: {
      getCities: (p: Record<string, any>) => npOk(CITIES.filter((c) => [c.Description, c.DescriptionRu].some((n) => n.toLowerCase().includes(String(p.FindByString).toLowerCase())))),
      getWarehouses: (p: Record<string, any>) => npOk(BRANCHES.filter((b) => b.CityRef === p.CityRef && (!p.FindByString || b.Number === p.FindByString || b.Description.includes(p.FindByString)))),
      getCounterparties: () => npOk([{ Ref: NP.senderRef, Description: 'ФОП Тест', CounterpartyType: 'PrivatePerson' }]),
      getCounterpartyContactPersons: () => npOk([{ Ref: NP.senderContactRef, Description: 'Тест Власник', Phones: '380671234567' }]),
      save: (p: Record<string, any>, model: string): Response | Promise<Response> => {
        if (model === 'Counterparty') return npOk([{ Ref: `recipient-${p.Phone}`, Description: `${p.LastName} ${p.FirstName}`, ContactPerson: { success: true, data: [{ Ref: `contact-${p.Phone}`, Description: p.LastName }] } }]);
        const ttn = String(++ttnSeq);
        np.statuses.set(ttn, { code: '1', text: 'Відправник самостійно створив цю накладну, але ще не надав до відправки' });
        return npOk([{ Ref: `doc-${ttn}`, CostOnSite: 70, EstimatedDeliveryDate: '03.11.2026', IntDocNumber: ttn, TypeDocument: 'InternetDocument' }]);
      },
      getStatusDocuments: (p: Record<string, any>) =>
        npOk((p.Documents as Array<{ DocumentNumber: string }>).flatMap((d) => {
          const s = np.statuses.get(d.DocumentNumber);
          return s ? [{ Number: d.DocumentNumber, StatusCode: s.code, Status: s.text }] : [{ Number: d.DocumentNumber, StatusCode: '3', Status: 'Номер не знайдено' }];
        })),
    } as Record<string, (p: Record<string, any>, model: string) => Response | Promise<Response>>,
    /** For `fetchImpl`: answers only api.novaposhta.ua; `other` handles anything else (e.g. Telegram). */
    fetchFor(other?: typeof fetch): typeof fetch {
      return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('https://api.novaposhta.ua/v2.0/json/')) {
          if (other) return other(input, init);
          throw new Error(`unexpected url ${url}`);
        }
        const b = JSON.parse(String(init?.body ?? '{}'));
        np.calls.push({ calledMethod: b.calledMethod, modelName: b.modelName, apiKey: b.apiKey, props: b.methodProperties ?? {} });
        if (!np.validKeys.has(b.apiKey)) return npErr(['API key expired'], ['20000200068']);
        const h = np.handlers[b.calledMethod];
        return h ? h(b.methodProperties ?? {}, b.modelName) : npErr(['Method not found']);
      }) as typeof fetch;
    },
  };
  return np;
}
export type FakeNp = ReturnType<typeof fakeNovaPoshta>;

/** The checkout lookups the agent makes before a draft, in one model step: city, branch, payment methods. */
export const npLookups = (phone = '+380501112233', branchQuery = '5'): LlmStep => ({
  toolCalls: [
    { id: 'c_city', name: 'find_np_city', arguments: JSON.stringify({ query: 'Київ' }) },
    { id: 'c_branch', name: 'find_np_branch', arguments: JSON.stringify({ cityRef: NP.kyivRef, query: branchQuery }) },
    { id: 'c_pay', name: 'get_checkout_options', arguments: JSON.stringify({ phone }) },
  ],
});
/** Draft arguments matching `npLookups` (Kyiv, branch 5, cash on delivery). */
export const npOrder = (items: Array<{ sku: string; quantity: number }>, over: Record<string, unknown> = {}) => ({
  items,
  firstName: 'Олена',
  lastName: 'Коваль',
  phone: '050 111 22 33',
  cityRef: NP.kyivRef,
  branchRef: NP.branch5Ref,
  paymentMethod: 'cod',
  ...over,
});
