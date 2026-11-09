import type { AgentRepository } from './agent';
import type { AuthRepository } from './auth';
import type { CatalogRepository, CreateProductInput } from './catalog';
import type { DbHandle } from './db';
import type { PolicyRepository, PolicyTopic } from './policies';
import type { CreateShopInput, ShopRepository, ShopRow } from './shops';

/** Creates a shop and its owner membership as one atomic step. */
export async function createShopWithOwner(d: { handle: DbHandle; shops: ShopRepository; auth: AuthRepository }, input: CreateShopInput, ownerUserId: string): Promise<ShopRow> {
  return d.handle.transaction(() => {
    const shop = d.shops.createTx(input);
    d.auth.addMemberTx(shop.id, ownerUserId, 'owner');
    return shop;
  });
}

/** Creates a memberless shop with its catalog, policies and AI notes as one atomic step. Returns the shop id. */
export async function seedShop(
  d: { handle: DbHandle; shops: ShopRepository; catalog: CatalogRepository; policies: PolicyRepository; agent: AgentRepository },
  input: CreateShopInput,
  products: CreateProductInput[],
  policies: Partial<Record<PolicyTopic, string>>,
  instructions: string,
): Promise<string> {
  return d.handle.transaction(() => {
    const shop = d.shops.createTx(input);
    for (const p of products) d.catalog.createProductTx(shop.id, p);
    for (const [topic, text] of Object.entries(policies)) d.policies.saveTx(shop.id, topic as PolicyTopic, text, null);
    d.agent.updateSettingsTx(shop.id, { instructions });
    return shop.id;
  });
}
