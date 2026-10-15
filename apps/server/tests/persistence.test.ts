/**
 * 持久化驱动与增量落盘的测试（审计 B1）。
 *
 * 重点覆盖「重启后数据还在不在」这条链路，以及 diff 计算的正确性。
 * SQLite 用 Node 内置驱动，不需要真实数据库服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, emptyStore, getStore, __resetStoreForTests } from '../src/db/store.ts';
import { FileDriver, SqliteDriver, createPersistenceDriver } from '../src/db/drivers.ts';
import { COLLECTIONS, batchIsEmpty, diffSnapshot, emptyBatch } from '../src/db/driver.ts';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 造一条最小可用的宠物记录（只要 id 就够 diff 用了） */
const pet = (id: string, name = '测试') =>
  ({ id, name, ownerId: 'u1' }) as unknown as Record<string, unknown>;

/* ============================================================
 * diff 计算
 * ============================================================ */

test('B1: diff 只包含新增记录，不包含未变化的部分', () => {
  const before = { pets: [pet('p1')], memories: [] } as Record<string, unknown>;
  const after = { pets: [pet('p1'), pet('p2')], memories: [] } as Record<string, unknown>;
  const batch = diffSnapshot(before, after);

  assert.equal(batch.upserts.pets?.length, 1, '只有新增的 p2 需要写入');
  assert.equal(batch.upserts.pets?.[0]?.id, 'p2');
  assert.equal(batch.upserts.memories, undefined, '没变化的集合不应产生写入');
  assert.equal(batch.deletes.pets, undefined);
});

test('B1: diff 能识别内容变化与删除', () => {
  const before = { pets: [pet('p1', '旧名字')], memories: [{ id: 'm1' }] } as Record<string, unknown>;
  const after = { pets: [pet('p1', '新名字')], memories: [] } as Record<string, unknown>;
  const batch = diffSnapshot(before, after);

  assert.equal(batch.upserts.pets?.length, 1, '改名要产生更新');
  assert.deepEqual(batch.deletes.memories, ['m1'], '被删掉的记录要进 deletes');
});

test('B1: diff 覆盖单例字段（user / surveyAnswers / meta）', () => {
  const before = { user: null, meta: { a: 1 } } as Record<string, unknown>;
  const after = { user: { id: 'u1' }, meta: { a: 2 } } as Record<string, unknown>;
  const batch = diffSnapshot(before, after);

  assert.deepEqual(batch.singletons.user, { id: 'u1' });
  assert.deepEqual(batch.singletons.meta, { a: 2 });
  assert.equal(batch.singletons.surveyAnswers, undefined, '未变化不应出现');
});

test('B1: 空 diff 被识别为空批次（避免无意义写库）', () => {
  const snapshot = { pets: [pet('p1')], meta: { x: 1 } } as Record<string, unknown>;
  const batch = diffSnapshot(snapshot, structuredClone(snapshot));
  assert.equal(batchIsEmpty(batch), true);
  assert.equal(batchIsEmpty(emptyBatch()), true);
});

/* ============================================================
 * 文件驱动
 * ============================================================ */

test('B1: 文件驱动可存取并识别坏档', async () => {
  const dir = tempDir('ruatrip-file-');
  try {
    const driver = new FileDriver(dir);
    // 没有存档时返回空对象（Store 会合并到默认空档上）
    assert.deepEqual(await driver.load(), {});

    await driver.persist({
      upserts: { pets: [{ id: 'p1', data: pet('p1') }] },
      deletes: {},
      singletons: { meta: { hello: 'world' } },
    });

    const loaded = await driver.load();
    assert.equal((loaded.pets as unknown[]).length, 1);
    assert.deepEqual(loaded.meta, { hello: 'world' });
    assert.equal(await driver.healthy(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
 * SQLite 驱动
 * ============================================================ */

test('B1: SQLite 驱动建表、存取、删除都正确', async () => {
  const dir = tempDir('ruatrip-sqlite-');
  const dbFile = join(dir, 'ruatrip.db');
  const driver = new SqliteDriver(dbFile);
  try {
    // 空库：所有集合都应存在且为空数组，单例为 null。
    // Store 加载时会把这些 null 合并成默认值（见 mergeSchema）。
    const initial = await driver.load();
    for (const name of COLLECTIONS) {
      assert.deepEqual(initial[name], [], `${name} 空库时应为空数组`);
    }
    assert.equal(initial.user, null);
    assert.equal(initial.meta, null);
    assert.equal(await driver.healthy(), true);

    await driver.persist({
      upserts: {
        pets: [
          { id: 'p1', data: pet('p1', '甲') },
          { id: 'p2', data: pet('p2', '乙') },
        ],
        memories: [{ id: 'm1', data: { id: 'm1', content: '记得' } }],
      },
      deletes: {},
      singletons: { user: { id: 'u1' }, meta: { streakDays: 3 } },
    });

    let loaded = await driver.load();
    assert.equal((loaded.pets as { id: string }[]).length, 2);
    assert.deepEqual(loaded.user, { id: 'u1' });
    assert.deepEqual(loaded.meta, { streakDays: 3 });
    // 所有集合都必须存在（哪怕是空数组），否则上层合并会踩 null
    for (const name of COLLECTIONS) {
      assert.ok(Array.isArray(loaded[name]), `${name} 必须是数组，实际 ${typeof loaded[name]}`);
    }

    // upsert 语义：同 id 再写一次是更新而不是插入
    await driver.persist({
      upserts: { pets: [{ id: 'p1', data: pet('p1', '甲改名') }] },
      deletes: { memories: ['m1'] },
      singletons: {},
    });
    loaded = await driver.load();
    assert.equal((loaded.pets as { id: string }[]).length, 2, '不应产生重复行');
    const updated = (loaded.pets as { id: string; name: string }[]).find((p) => p.id === 'p1');
    assert.equal(updated?.name, '甲改名');
    assert.equal((loaded.memories as unknown[]).length, 0, '删除应生效');
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1: SQLite 数据在进程内重开后仍在（模拟容器重建）', async () => {
  const dir = tempDir('ruatrip-restart-');
  const dbFile = join(dir, 'ruatrip.db');
  try {
    // 第一次「进程」
    const first = new SqliteDriver(dbFile);
    await first.persist({
      upserts: { pets: [{ id: 'pet-1', data: pet('pet-1', '汤圆') }] },
      deletes: {},
      singletons: { user: { id: 'u1', nickname: '主人' } },
    });
    await first.close();

    // 第二次「进程」——这是修复前会丢数据的场景
    const second = new SqliteDriver(dbFile);
    const loaded = await second.load();
    assert.equal((loaded.pets as { name: string }[])[0]?.name, '汤圆', '重启后宠物必须还在');
    assert.deepEqual((loaded.user as { nickname: string }).nickname, '主人');
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1: SQLite 事务性 —— 一批变更要么全成功要么全回滚', async () => {
  const dir = tempDir('ruatrip-tx-');
  const driver = new SqliteDriver(join(dir, 'ruatrip.db'));
  try {
    await driver.persist({
      upserts: { pets: [{ id: 'ok', data: pet('ok') }] },
      deletes: { memories: ['nonexistent'] },
      singletons: {},
    });
    const loaded = await driver.load();
    assert.equal((loaded.pets as unknown[]).length, 1);
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
 * Store 与驱动的集成
 * ============================================================ */

test('B1: Store 用 SQLite 驱动时，重构实例后数据仍在', async () => {
  const dir = tempDir('ruatrip-store-sqlite-');
  const dbFile = join(dir, 'ruatrip.db');
  try {
    const driverA = new SqliteDriver(dbFile);
    const storeA = new Store(dir, { driver: driverA, debounceMs: 0 });
    await storeA.init();
    storeA.update((d) => {
      d.pets.push(pet('pet-1', '云朵') as never);
      d.meta.streakDays = 5;
      d.user = { id: 'u1', nickname: '我' } as never;
      return true;
    });
    await storeA.flush();
    await storeA.close();

    const driverB = new SqliteDriver(dbFile);
    const storeB = new Store(dir, { driver: driverB, debounceMs: 0 });
    await storeB.init();
    assert.equal(storeB.read().pets.length, 1);
    assert.equal((storeB.read().pets[0] as { name: string }).name, '云朵');
    assert.equal(storeB.read().meta.streakDays, 5);
    assert.equal(storeB.read().user?.nickname, '我');
    await storeB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1: 空库加载后 meta 必须是对象而不是 null（否则 getMeta 会崩）', async () => {
  const dir = tempDir('ruatrip-nullmeta-');
  const driver = new SqliteDriver(join(dir, 'ruatrip.db'));
  try {
    const store = new Store(dir, { driver, debounceMs: 0 });
    await store.init();
    // 这是修复前的真实崩溃点：SQLite 单例表为空 → load 返回 meta:null
    // → 展开运算覆盖掉默认的 {} → getMeta 读 null.streakDays 抛异常
    assert.equal(typeof store.read().meta, 'object');
    assert.notEqual(store.read().meta, null);
    assert.deepEqual(store.read().meta, {});
    for (const name of COLLECTIONS) {
      assert.ok(Array.isArray(store.read()[name]), `${name} 必须是数组`);
    }
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B1: 坏字段形态不会污染内存快照', async () => {
  const dir = tempDir('ruatrip-badshape-');
  try {
    const store = new Store(dir, { debounceMs: 0 });
    // 直接写一个字段形态全错的存档
    const bad = { ...emptyStore(), meta: null, pets: 'not-an-array', user: 42 };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'ruatrip.json'), JSON.stringify(bad), 'utf8');

    const reloaded = new Store(dir, { debounceMs: 0 });
    assert.deepEqual(reloaded.read().meta, {}, 'meta 应回落空对象');
    assert.deepEqual(reloaded.read().pets, [], 'pets 应回落空数组');
    assert.equal(reloaded.read().user, null, '非法 user 应回落 null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================================
 * 驱动选择
 * ============================================================ */

test('B1: 驱动选择遵循 auto → postgres → sqlite → file 的优先级', () => {
  const base = { dataDir: '/tmp/x', sqliteFile: '/tmp/x/ruatrip.db', pgSsl: false };

  const pg = createPersistenceDriver({
    ...base,
    driver: 'auto',
    databaseUrl: 'postgres://user:pw@host:5432/db',
  });
  assert.equal(pg.driver.kind, 'postgres');

  const sqliteFromUrl = createPersistenceDriver({
    ...base,
    driver: 'auto',
    databaseUrl: 'file:./data/custom.db',
  });
  assert.equal(sqliteFromUrl.driver.kind, 'sqlite');

  const sqliteDefault = createPersistenceDriver({ ...base, driver: 'auto', databaseUrl: '' });
  assert.ok(['sqlite', 'file'].includes(sqliteDefault.driver.kind), 'Node 版本决定是 sqlite 还是 file');

  const forcedFile = createPersistenceDriver({ ...base, driver: 'file', databaseUrl: '' });
  assert.equal(forcedFile.driver.kind, 'file');
  assert.ok(forcedFile.productionWarning, '文件驱动必须给出生产环境告警');
});

test('B1: 指定 postgres 却没给连接串时明确报错', () => {
  assert.throws(
    () =>
      createPersistenceDriver({
        dataDir: '/tmp/x',
        driver: 'postgres',
        databaseUrl: '',
        sqliteFile: '/tmp/x/ruatrip.db',
        pgSsl: false,
      }),
    /PERSISTENCE_CONFIG/,
  );
});

test('B1: 连接串里的密码不会出现在描述文本里', () => {
  const choice = createPersistenceDriver({
    dataDir: '/tmp/x',
    driver: 'postgres',
    databaseUrl: 'postgres://alice:supersecret@db.example.com:5432/ruatrip',
    sqliteFile: '/tmp/x/ruatrip.db',
    pgSsl: false,
  });
  assert.ok(!choice.description.includes('supersecret'), `描述里不能有密码：${choice.description}`);
});

/* ============================================================
 * 单例工厂
 * ============================================================ */

test('B1: getStore 返回同一实例，测试可重置', () => {
  __resetStoreForTests();
  const dir = tempDir('ruatrip-singleton-');
  try {
    const a = getStore(dir, { debounceMs: 0 });
    const b = getStore(dir, { debounceMs: 0 });
    assert.equal(a, b, '同一目录应复用实例');
    __resetStoreForTests();
    const c = getStore(dir, { debounceMs: 0 });
    assert.notEqual(a, c, '重置后应是新实例');
  } finally {
    __resetStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件驱动仍会写出 ruatrip.json（向后兼容）', async () => {
  const dir = tempDir('ruatrip-compat-');
  try {
    const store = new Store(dir, { debounceMs: 0 });
    store.update((d) => {
      d.meta.ping = 'pong';
      return true;
    });
    await store.flush();
    assert.equal(existsSync(join(dir, 'ruatrip.json')), true);
    const parsed = JSON.parse(readFileSync(join(dir, 'ruatrip.json'), 'utf8'));
    assert.equal(parsed.meta.ping, 'pong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
