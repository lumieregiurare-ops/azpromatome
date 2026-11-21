// 自動の取得を断ってきたサイト（403 / 429 / 503 を返したサイト）を覚えておき、しばらく取りに行かない。
// 断られたのに取りに行き続けると相手の負担になり、こちらも締め出されるため。
// 記録は data/hosts.json。期限が過ぎたら 1 回だけ試し、また断られたら期限を延ばす。
import { join } from "node:path";
import { readJson, writeJson } from "./util.mjs";

const HOURS = { 403: 24 * 7, 401: 24 * 7, 429: 24, 503: 6 };

export async function loadHostGuard(root) {
  const path = join(root, "data", "hosts.json");
  const data = (await readJson(path, {})) || {};
  const now = Date.now();
  return {
    blocked(host) {
      const e = host && data[host];
      return !!(e && new Date(e.until).getTime() > now);
    },
    // fetch で投げられたエラー（"HTTP 403 ..."）を見て、断られたものなら記録する。記録したら true
    note(host, err) {
      const m = String(err?.message || err).match(/HTTP (\d{3})/);
      const status = m ? Number(m[1]) : 0;
      if (!host || !HOURS[status]) return false;
      const prev = data[host];
      const times = (prev?.times || 0) + 1;
      // 続けて断られるほど長くあける（最大 4 倍）
      const hours = HOURS[status] * Math.min(4, times);
      data[host] = { status, times, at: new Date(now).toISOString(), until: new Date(now + hours * 3600000).toISOString() };
      return true;
    },
    ok(host) {
      if (host && data[host]) delete data[host];
    },
    list: () => Object.keys(data).filter((h) => new Date(data[h].until).getTime() > now),
    save: () => writeJson(path, data),
  };
}
