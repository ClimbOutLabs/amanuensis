import Database from 'better-sqlite3';
import { cacheStatements } from '../../../../src/db/sqlite/client';

function openDatabase(): Database.Database {
  const database = new Database(':memory:');
  database.exec('create table item (id integer primary key, name text)');
  database.exec("insert into item (name) values ('a'), ('b'), ('c')");
  return database;
}

describe('cacheStatements', () => {
  it('reuses one statement for the same SQL text', () => {
    const database = openDatabase();
    const prepare = jest.spyOn(database, 'prepare');
    const cached = cacheStatements({ database, maxSize: 10 });

    const first = cached.prepare('select name from item order by id');
    const second = cached.prepare('select name from item order by id');

    expect(second).toBe(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(second.all([])).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    database.close();
  });

  it('gives a fresh statement while the cached one is still being iterated', () => {
    const database = openDatabase();
    const cached = cacheStatements({ database, maxSize: 10 });
    const sql = 'select name from item order by id';

    const outer = cached.prepare(sql);
    const outerRows = outer.iterate([]);
    const firstOuter = outerRows.next();

    const inner = cached.prepare(sql);
    expect(inner).not.toBe(outer);
    expect(inner.all([])).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);

    expect(firstOuter.value).toEqual({ name: 'a' });
    expect([...outerRows]).toEqual([{ name: 'b' }, { name: 'c' }]);
    expect(cached.prepare(sql)).toBe(inner);
    database.close();
  });

  it('drops the least recently used statement past the size limit', () => {
    const database = openDatabase();
    const prepare = jest.spyOn(database, 'prepare');
    const cached = cacheStatements({ database, maxSize: 2 });

    const one = cached.prepare('select 1');
    cached.prepare('select 2');
    expect(cached.prepare('select 1')).toBe(one);
    cached.prepare('select 3');

    expect(cached.prepare('select 1')).toBe(one);
    expect(prepare).toHaveBeenCalledTimes(3);
    cached.prepare('select 2');
    expect(prepare).toHaveBeenCalledTimes(4);
    database.close();
  });

  it('closes the database', () => {
    const database = openDatabase();
    cacheStatements({ database, maxSize: 10 }).close();
    expect(database.open).toBe(false);
  });
});
