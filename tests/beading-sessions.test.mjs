import assert from 'node:assert/strict';
import { createBeadingSessionStore, createSessionTimer } from '../public/beading-sessions.js';

// The generic memory driver supplies only atomic persistence. Production recovery,
// lease, completion and timer logic are the actual exported implementation.
class MemoryBackend {
  records = new Map(); failNext = false;
  async create(value) { this.records.set(value.id, structuredClone(value)); return structuredClone(value); }
  async get(id) { return structuredClone(this.records.get(id) || null); }
  async list() { return structuredClone([...this.records.values()]); }
  async update(id, mutate) {
    if (this.failNext) { this.failNext = false; throw new Error('Storage unavailable'); }
    const value = mutate(structuredClone(this.records.get(id)));
    this.records.set(id, structuredClone(value)); return structuredClone(value);
  }
}
class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
class Page extends EventTarget { hidden = false; }
function clock() {
  let mono = 0, wall = Date.parse('2026-10-25T12:00:00Z'), next = 0;
  const callbacks = new Map();
  return { now: () => wall, monotonicNow: () => mono,
    setInterval(fn) { const id = ++next; callbacks.set(id, fn); return id; }, clearInterval(id) { callbacks.delete(id); },
    advance(ms, fire = true) { mono += ms; wall += ms; if (fire) for (const fn of [...callbacks.values()]) fn(); },
    changeWall(ms) { wall += ms; }, crash() { callbacks.clear(); }
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const project = () => ({ format: 'bead-studio', version: 1, width: 8, height: 8, cells: Array(64).fill('R'), palette: { name: 'Test', colors: [{code:'R',hex:'#cc3344'}] }, projectName: '计时图', done: [] });
function fixture() {
  const backend = new MemoryBackend(), storage = new Storage(), time = clock(), document = new Page(), window = new EventTarget(); let sequence = 0;
  const store = createBeadingSessionStore({ backend, storage, now: time.now, id: () => 'craft-' + ++sequence });
  const errors = [];
  const timer = (owner, extra = {}) => createSessionTimer({ store, ...time, document, window, owner, navigator: {}, onError: cause => errors.push(cause), ...extra });
  const create = () => store.create({projectId:'drawing-test',name:'计时图',project:project(),thumbnail:'data:image/png;base64,test'});
  return {backend,storage,time,document,window,store,timer,create,errors};
}

{
  const f = fixture(), input = project();
  const created = await f.store.create({projectId:'drawing-test',name:'计时图',project:input}); input.cells[0] = null;
  assert.equal((await f.store.get(created.id)).project.cells[0], 'R', 'Snapshots must not share mutable input arrays');
  assert.equal((await f.store.findPending('drawing-test', project())).id, created.id);
  const other = project(); other.cells[0] = null; assert.equal(await f.store.findPending('drawing-test', other), null, 'A modified pattern starts a different craft record');
  assert.equal(await f.store.findPending('another-design', project()), null);
  console.log('PASS immutable snapshots and exact pending-pattern matching');
}
{
  const f = fixture(), record = await f.create(), timer = f.timer('one'); await timer.open(record.id);
  for (let i=0;i<3;i++) f.time.advance(1000);
  f.time.advance(400, false); await timer.pause(); assert.equal(timer.current().elapsedMs, 3400);
  f.time.advance(3600000); await settle(); assert.equal(timer.current().elapsedMs, 3400, 'Paused time is excluded');
  await timer.resume(); f.time.advance(1000); f.time.changeWall(-3600000); f.time.advance(1000);
  await timer.setDone([1,2]); await timer.detach();
  const saved = await f.store.get(record.id); assert.equal(saved.elapsedMs, 5400, 'Clock changes cannot change active duration'); assert.deepEqual(saved.project.done,[1,2]);
  await timer.dispose(); console.log('PASS precise pause/resume, wall-clock changes, progress persistence and normal exit');
}
{
  const f = fixture(), record = await f.create(), first = f.timer('first'); await first.open(record.id);
  f.time.advance(1000);f.time.advance(1000); await first.setDone([4]); f.time.advance(1000); f.time.advance(700,false);
  f.time.crash();
  const durable = await f.store.get(record.id); assert.equal(durable.elapsedMs,3000,'Abrupt restart recovers the last one-second journal, not offline time');
  f.time.advance(60000,false); const second=f.timer('second'); await second.open(record.id); assert.equal(second.current().elapsedMs,3000);
  assert.deepEqual(second.current().project.done,[4]); f.time.advance(1000);await second.pause();assert.equal(second.current().elapsedMs,4000);
  await assert.rejects(first.flush(), {code:'SESSION_LOST'}, 'An obsolete tab cannot overwrite a newer timer owner');
  await second.dispose(); console.log('PASS abrupt-exit recovery, bounded unsaved tail, no offline counting and stale-owner rejection');
}
{
  const f = fixture(), record = await f.create(), timer=f.timer('visible');await timer.open(record.id);
  f.time.advance(1000); f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange')); await settle();
  f.time.advance(600000);await settle();assert.equal(timer.current().elapsedMs,1000);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(timer.current().running,true);
  f.time.advance(1000);await timer.pause();
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));await settle();
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(timer.current().running,false,'Explicit pause survives a background/foreground cycle');
  await timer.resume();f.time.advance(120000);assert.equal(timer.current().elapsedMs,2000,'Frozen visible tab time is not silently added');
  await timer.dispose(); console.log('PASS hidden-page pause, appropriate resume and frozen-page gap exclusion');
}
{
  const f=fixture(),record=await f.create(),one=f.timer('one'),two=f.timer('two');await one.open(record.id);
  await assert.rejects(two.open(record.id),{code:'SESSION_BUSY'});assert.equal(two.current().running,false);
  f.time.advance(1000); await one.setDone([0]);f.backend.failNext=true;
  await assert.rejects(one.complete(),/Storage unavailable/);assert.equal(one.current().status,'in_progress','Failed completion must not become a completed UI state');
  const completed=await one.complete();assert.equal(completed.status,'completed');assert.equal(completed.completedAt,new Date(f.time.now()).toISOString());assert.equal(completed.elapsedMs,1000);
  f.time.advance(3600000);assert.equal(one.current().elapsedMs,1000);
  await two.open(record.id);assert.equal(two.current().running,false);assert.equal(two.current().status,'completed');
  await assert.rejects(two.setDone([2]),{code:'SESSION_COMPLETED'});
  const before=await f.store.get(record.id);await f.store.checkpoint(record.id,'one',before.epoch,{elapsedMs:999999,sequence:999,done:[5]});assert.deepEqual(await f.store.get(record.id),before,'Late checkpoints cannot change completed records');
  assert.equal(await f.store.findPending('drawing-test',project()),null);await one.dispose();await two.dispose();
  console.log('PASS concurrent-tab exclusion, failed completion recovery and immutable completed records');
}
{
  const f=fixture(),record=await f.create(),timer=f.timer('pagehide');await timer.open(record.id);f.time.advance(1000);f.time.advance(350,false);
  f.window.dispatchEvent(new Event('pagehide'));
  assert.equal((await f.store.get(record.id)).elapsedMs,1350,'pagehide journals the tail synchronously');await settle();
  f.time.advance(600000);assert.equal(timer.current().running,false);assert.equal((await f.store.get(record.id)).elapsedMs,1350);
  await timer.dispose();console.log('PASS normal page exit synchronously captures the final fraction of a second');
}
{
  const f=fixture(),record=await f.create(),held=new Map();
  const locks={request(name,_options,callback){
    if(held.has(name))return Promise.resolve(callback(null));
    const token={name};held.set(name,token);
    return Promise.resolve(callback(token)).finally(()=>{if(held.get(name)===token)held.delete(name);});
  }};
  const one=f.timer('browser-one',{navigator:{locks}}),two=f.timer('browser-two',{navigator:{locks}});
  await one.open(record.id);f.time.advance(1000);
  await assert.rejects(two.open(record.id),{code:'SESSION_BUSY'});
  // Browser processes release their Web Locks on crash, while the last persisted
  // lease may still be fresh. An exclusive new owner may recover immediately.
  f.time.crash();held.clear();await two.open(record.id);
  assert.equal(two.current().elapsedMs,1000);assert.equal(two.current().running,true);
  await assert.rejects(one.flush(),{code:'SESSION_LOST'});
  await two.dispose();await one.dispose();
  console.log('PASS Web Locks reject simultaneous timers and allow immediate recovery after browser crash');
}
console.log('All beading session storage and timer tests passed.');
