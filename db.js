/* IndexedDB の簡単なラッパー（画面と Worker の両方で使う） */
(function (root) {
  'use strict';
  var NAME = 'haitatsu-navi', VER = 1;
  var dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(NAME, VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { dbp = null; rej(rq.error); };
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), st = t.objectStore(store), out;
        var r = fn(st);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  var DB = {
    get: function (store, key) { return tx(store, 'readonly', function (s) { return s.get(key); }); },
    put: function (store, key, val) { return tx(store, 'readwrite', function (s) { return s.put(val, key); }); },
    del: function (store, key) { return tx(store, 'readwrite', function (s) { return s.delete(key); }); },
    has: function (store, key) { return tx(store, 'readonly', function (s) { return s.getKey(key); }).then(function (k) { return k !== undefined; }); },
    count: function (store, range) { return tx(store, 'readonly', function (s) { return s.count(range); }); },
    keys: function (store, range) { return tx(store, 'readonly', function (s) { return s.getAllKeys(range); }); },
    clear: function (store, range) { return tx(store, 'readwrite', function (s) { return range ? s.delete(range) : s.clear(); }); },
    putMany: function (store, items) { // [[key,val],...]
      return tx(store, 'readwrite', function (s) { items.forEach(function (it) { s.put(it[1], it[0]); }); return null; });
    },
    prefix: function (p) { return IDBKeyRange.bound(p, p + '￿'); }
  };
  root.DB = DB;
})(this);
