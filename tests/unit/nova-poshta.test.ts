import { describe, expect, it } from 'vitest';
import { createEgress } from '../../apps/api/src/services/egress';
import { NovaPoshtaApi, NovaPoshtaError, trackingOutcome } from '../../apps/api/src/services/nova-poshta';
import { NP, NP_KEY, fakeNovaPoshta, npErr, npOk } from '../fixtures/fake-nova-poshta';

// Request and response shapes from NP's public API documentation (see the fixture).
const client = (np = fakeNovaPoshta()) => ({ np, api: new NovaPoshtaApi(createEgress({ fetchImpl: np.fetchFor() })) });

describe('NovaPoshtaApi', () => {
  it('sends the documented envelope and parses cities and working branches only', async () => {
    const { np, api } = client();
    expect(await api.searchCities(NP_KEY, 'київ')).toEqual([{ ref: NP.kyivRef, name: 'Київ', area: 'Київська' }]);
    expect(np.calls[0]).toMatchObject({ modelName: 'Address', calledMethod: 'getCities', apiKey: NP_KEY, props: { FindByString: 'київ' } });
    const all = await api.searchWarehouses(NP_KEY, NP.kyivRef, '');
    expect(all.map((w) => w.number)).toEqual(['5', '12']); // the closed branch is dropped
    expect(await api.searchWarehouses(NP_KEY, NP.kyivRef, '5')).toEqual([{ ref: NP.branch5Ref, cityRef: NP.kyivRef, number: '5', name: expect.stringContaining('№5') }]);
  });

  it('reads the sender identity and normalizes its phone', async () => {
    const { api } = client();
    expect(await api.senderIdentity(NP_KEY)).toEqual({ senderRef: NP.senderRef, contactRef: NP.senderContactRef, phone: '+380671234567' });
  });

  it('classifies failures: refused key, business refusal, no usable answer; never keeps NP text', async () => {
    const { np, api } = client();
    await expect(api.searchCities('f'.repeat(32), 'Київ')).rejects.toMatchObject({ kind: 'auth' });
    np.handlers.getCities = () => npErr(['FindByString is invalid. Олена +380501112233'], ['20000900746']);
    const e = await api.searchCities(NP_KEY, 'x').catch((x) => x);
    expect(e).toBeInstanceOf(NovaPoshtaError);
    expect(e).toMatchObject({ kind: 'rejected', codes: ['20000900746'] });
    expect(e.message).not.toContain('Олена');
    np.handlers.getCities = () => new Response('oops', { status: 502 });
    await expect(api.searchCities(NP_KEY, 'x')).rejects.toMatchObject({ kind: 'unavailable' });
    np.handlers.getCities = () => new Response('not json', { status: 200 });
    await expect(api.searchCities(NP_KEY, 'x')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('creates a COD TTN with the server amount and NP-style phones; a success without a number is uncertain', async () => {
    const { np, api } = client();
    const recipient = await api.createRecipient(NP_KEY, { firstName: 'Олена', lastName: 'Коваль', phone: '+380501112233' });
    expect(recipient).toEqual({ ref: 'recipient-380501112233', contactRef: 'contact-380501112233' });
    const input = {
      sender: { ref: NP.senderRef, contactRef: NP.senderContactRef, phone: '+380671234567', cityRef: NP.kyivRef, warehouseRef: NP.branch12Ref },
      recipient: { firstName: 'Олена', lastName: 'Коваль', phone: '+380501112233', cityRef: NP.lvivRef, warehouseRef: NP.lvivBranchRef },
      costUah: '2598',
      cod: true,
      weightKg: '0.5',
      description: 'Одяг',
      date: '31.10.2026',
    };
    const r = await api.createTtn(NP_KEY, recipient, input);
    expect(r.ttn).toMatch(/^2045\d{10}$/);
    const save = np.calls.find((c) => c.modelName === 'InternetDocument')!;
    expect(save.props).toMatchObject({
      PayerType: 'Recipient',
      ServiceType: 'WarehouseWarehouse',
      Cost: '2598',
      SendersPhone: '380671234567',
      RecipientsPhone: '380501112233',
      RecipientAddress: NP.lvivBranchRef,
      BackwardDeliveryData: [{ PayerType: 'Recipient', CargoType: 'Money', RedeliveryString: '2598' }],
    });
    np.handlers.save = () => npOk([{ Ref: 'doc-x' }]);
    await expect(api.createTtn(NP_KEY, recipient, input)).rejects.toMatchObject({ kind: 'unavailable', codes: ['NO_TTN_IN_ANSWER'] });
  });

  it('tracks up to 100 TTNs per call with the phone', async () => {
    const { np, api } = client();
    np.statuses.set('20450000000001', { code: '9', text: 'Відправлення отримано' });
    expect(await api.track(NP_KEY, [{ ttn: '20450000000001', phone: '+380501112233' }])).toEqual([{ ttn: '20450000000001', code: '9', text: 'Відправлення отримано' }]);
    expect(np.calls.at(-1)!.props.Documents).toEqual([{ DocumentNumber: '20450000000001', Phone: '380501112233' }]);
  });

  it('only reaches the allow-listed NP host', async () => {
    const api = new NovaPoshtaApi(createEgress({ fetchImpl: fakeNovaPoshta().fetchFor() }), 'https://evil.example/v2.0/json/');
    await expect(api.searchCities(NP_KEY, 'Київ')).rejects.toThrow(/not allowed/);
  });
});

describe('trackingOutcome', () => {
  it('maps documented status codes', () => {
    expect(trackingOutcome('9')).toEqual({ outcome: 'delivered', refusal: false });
    expect(trackingOutcome('11')).toEqual({ outcome: 'delivered', refusal: false });
    expect(trackingOutcome('103')).toEqual({ outcome: 'returning', refusal: true });
    expect(trackingOutcome('102')).toEqual({ outcome: 'returning', refusal: true });
    expect(trackingOutcome('105')).toEqual({ outcome: 'returning', refusal: false });
    expect(trackingOutcome('5')).toEqual({ outcome: null, refusal: false });
  });
});
