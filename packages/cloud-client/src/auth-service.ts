/**
 * Authentication, JWT session helpers, and ThingsBoard customer hierarchy lookup.
 */

import { EntityType, type CustomerOption, type UserProfile } from '#firmware-core';
import {
  configureCloudConnection,
  ensureFreshCloudJwtToken,
  getJwtExpirationMs,
  setCloudJwtToken,
  subscribeCloudTokens,
  TbService,
  type CloudConnectionConfig,
} from './http-client.ts';

export const NULL_UUID = '13814000-1dd2-11b2-8080-808080808080';
const TRAILING_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cleanCustomerTitle(rawTitle: unknown, ownerUuid: string | null = null): string {
  if (!rawTitle) return '';
  let str = String(rawTitle).trim();
  str =
    ownerUuid && str.endsWith(ownerUuid)
      ? str.slice(0, str.length - ownerUuid.length).trim()
      : str.replace(TRAILING_UUID_RE, '').trim();
  return str
    .replace(/@AutoCreatedHierachyGroupForSubCustomers/gi, ' (Auto)')
    .replace(/@AutoCreatedHierarchyGroupForSubCustomers/gi, ' (Auto)')
    .replace(/@AutoCreated[^\s]*/gi, '')
    .trim();
}

const sortCustomers = (list: CustomerOption[]): CustomerOption[] =>
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

export class AuthService {
  static configure = (config: CloudConnectionConfig): void => configureCloudConnection(config);
  static setToken = (token: string | null, refreshToken: string | null = null): void =>
    setCloudJwtToken(token, refreshToken);
  static getTokenExpirationMs = getJwtExpirationMs;
  static ensureFreshToken = ensureFreshCloudJwtToken;
  static subscribeTokens = subscribeCloudTokens;

  static async login(username: string, password: string): Promise<{ token: string; refreshToken?: string }> {
    const data = await TbService.post<{ token: string; refreshToken?: string }>('/auth/login', { username, password });
    setCloudJwtToken(data.token, data.refreshToken || null);
    return data;
  }

  static getCurrentUser(): Promise<UserProfile> {
    return TbService.get<UserProfile>('/auth/user');
  }

  static async getAvailableCustomers(userProfile: UserProfile | null = null): Promise<CustomerOption[]> {
    // 1. TENANT_ADMIN: fetch full hierarchy to build `Parent › Sub-Customer` breadcrumbs
    if (!userProfile || userProfile.authority === 'TENANT_ADMIN') {
      try {
        const pageData = await TbService.get<{ data?: Record<string, any>[] }>(
          '/customers?pageSize=1000&page=0&sortProperty=title&sortOrder=ASC'
        );
        const byId = new Map<string, { id: string; parentId: string | null; rawName: string }>();
        for (const c of Array.isArray(pageData?.data) ? pageData.data : []) {
          const id = c.id?.id as string | undefined;
          if (!id || id === NULL_UUID) continue;
          const rawParent = c.parentCustomerId?.id || (c.ownerId?.entityType === EntityType.Customer ? c.ownerId?.id : null);
          const parentId = rawParent && rawParent !== NULL_UUID ? String(rawParent) : null;
          const rawName = cleanCustomerTitle(c.title || c.name || id, parentId || c.tenantId?.id || null) || id;
          byId.set(id, { id, parentId, rawName });
        }

        if (byId.size > 0) {
          const buildPath = (item: { id: string; parentId: string | null; rawName: string }, visited = new Set<string>()): string => {
            if (!item.parentId || !byId.has(item.parentId) || visited.has(item.id)) return item.rawName;
            visited.add(item.id);
            return `${buildPath(byId.get(item.parentId)!, visited)} › ${item.rawName}`;
          };
          return sortCustomers(
            Array.from(byId.values()).map((item) => ({
              id: item.id,
              entityType: EntityType.Customer,
              name: buildPath(item),
              rawName: item.rawName,
              parentCustomerId: item.parentId,
            }))
          );
        }
      } catch {
        // Fall through to /api/rr/customer/owners/available
      }
    }

    // 2. CUSTOMER_USER (or fallback)
    try {
      const owners = await TbService.get<Record<string, any>[]>('/rr/customer/owners/available');
      const seen = new Set<string>();
      const mapped: CustomerOption[] = [];
      for (const o of Array.isArray(owners) ? owners : []) {
        const id = o?.id?.id as string | undefined;
        if (!id || o?.id?.entityType !== EntityType.Customer || seen.has(id)) continue;
        seen.add(id);
        const cleanName = cleanCustomerTitle(o.name || id);
        mapped.push({ id, entityType: EntityType.Customer, name: cleanName, rawName: cleanName, parentCustomerId: null });
      }
      if (mapped.length > 0) return sortCustomers(mapped);
    } catch {
      // Fall through to profile's own customerId
    }

    // 3. Own customerId fallback
    const ownId = userProfile?.customerId?.id;
    if (!ownId || ownId === NULL_UUID) return [];
    const name = cleanCustomerTitle(userProfile?.customerTitle || userProfile?.name || `Customer (${ownId.slice(0, 8)})`);
    return [{ id: ownId, entityType: EntityType.Customer, name, rawName: name, parentCustomerId: null }];
  }
}
