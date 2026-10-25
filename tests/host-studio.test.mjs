import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostStore } from '../public/host-studio.js';

function memoryStorage() { const values = new Map(); return { getItem:key=>values.has(key)?values.get(key):null, setItem:(key,value)=>values.set(key,value), values }; }
const make = (storage = memoryStorage()) => { let sequence = 0; return createHostStore({ storage, id:()=>`shop-test-${++sequence}`, now:()=> '2026-10-25T12:00:00.000Z' }); };
const colors = [{ code:'A01', hex:'#ff9900', name:'橘色' }, { code:'A02', hex:'#112233', name:'深蓝', available:false }];

test('seed explicitly uses demo identifiers; saved catalogue survives a reload', () => {
 const storage=memoryStorage(), store=make(storage), demo=store.listShops()[0];
 assert.equal(demo.id,'shop-demo'); assert.equal(demo.isDemo,true); assert(demo.colors.every(c=>/^DEMO\d+$/.test(c.code)));
 const shop=store.createShop('真实店家',colors); assert.equal(shop.colors[0].hex,'#FF9900');
 const reloaded=make(storage).getShop(shop.id); assert.deepEqual(reloaded,shop); assert.equal(reloaded.colors[1].available,false);
 assert.equal(store.getAvailablePalette(shop.id).colors.length,1); assert.equal(store.getAvailablePalette(shop.id).colors[0].code,'A01');
});

test('editing, renaming and availability revisions do not mutate returned snapshots',()=>{
 const store=make(), shop=store.createShop('测试店',colors), snapshot=store.getAvailablePalette(shop.id);
 const changed=store.saveColor(shop.id,{code:'A03',hex:'#445566',name:'新色',available:true},'A01');
 assert.equal(changed.revision,2);assert.equal(snapshot.colors[0].code,'A01');assert.equal(snapshot.colors[0].hex,'#FF9900');
 assert.equal(store.renameShop(shop.id,'另一个名称').revision,3);
 assert.equal(store.setAvailability(shop.id,'A02',true).revision,4);
 assert.deepEqual(store.getAvailablePalette(shop.id).colors.map(c=>c.code),['A03','A02']);
 store.deleteColor(shop.id,'A03');assert.equal(store.getShop(shop.id).colors.length,1);
 store.deleteShop(shop.id);assert.equal(store.getShop(shop.id),null);assert.equal(snapshot.colors.length,1);
});

test('rejects duplicates, unsafe codes, bad HEX, overlong labels and invalid availability',()=>{
 const store=make(), shop=store.createShop('测试店',colors);
 assert.throws(()=>store.saveColor(shop.id,{code:'A01',hex:'#FFFFFF'}),/已存在/);
 assert.throws(()=>store.saveColor(shop.id,{code:'A02',hex:'#FFFFFF'},'A01'),/已存在/);
 assert.throws(()=>store.saveColor(shop.id,{code:'<script>',hex:'#FFFFFF'}),/色号无效/);
 assert.throws(()=>store.saveColor(shop.id,{code:'A03',hex:'red'}),/#RRGGBB/);
 assert.throws(()=>store.saveColor(shop.id,{code:'A03',hex:'#FFFFFF',name:'x'.repeat(61)}),/60/);
 assert.throws(()=>store.saveColor(shop.id,{code:'A03',hex:'#FFFFFF',available:'false'}),/状态/);
 assert.throws(()=>store.renameShop(shop.id,'  '),/名称/);
 assert.throws(()=>store.saveColor(shop.id,{code:'A03',hex:'#FFFFFF'},'gone'),/不存在/);
 assert.equal(store.getShop(shop.id).revision,1);
});

test('empty and unavailable shops cannot be used for conversion',()=>{
 const store=make(), empty=store.createShop('空色卡');
 assert.throws(()=>store.getAvailablePalette(empty.id),/还没有颜色/);
 const shop=store.createShop('缺货',colors.map(c=>({...c,available:false})));
 assert.throws(()=>store.getAvailablePalette(shop.id),/全部缺货/);
 store.setAvailability(shop.id,'A02',true);assert.equal(store.getAvailablePalette(shop.id).colors[0].code,'A02');
});

test('imports CSV and JSON with validated codes and preserves availability in JSON roundtrip',()=>{
 const store=make(), imported=store.importShop('code,hex,name\nC01,#AABBCC,蓝灰\nC02,#FFFFFF,白','店铺.csv');
 assert.equal(imported.name,'店铺');assert(imported.colors.every(c=>c.available));
 const json=store.importShop(JSON.stringify({name:'JSON 色卡',colors}),'颜色.json');assert.equal(json.colors[1].available,false);
 assert.throws(()=>store.importShop('code,hex\nA,#000000\nA,#FFFFFF','duplicate.csv'),/重复/);
});

test('enforces ten shops and one thousand colours',()=>{
 const store=make();for(let i=0;i<9;i++)store.createShop('店 '+i);
 assert.equal(store.listShops().length,10);assert.throws(()=>store.createShop('超出'),/10/);
 const other=make(), full=other.createShop('大色卡',Array.from({length:1000},(_,i)=>({code:'C'+i,hex:'#123456'})));
 assert.throws(()=>other.saveColor(full.id,{code:'X',hex:'#FFFFFF'}),/1000/);
 assert.equal(other.getShop(full.id).colors.length,1000);
});

test('a storage failure preserves the previous catalogue and permits an exact retry',()=>{
 const storage=memoryStorage(), store=make(storage), shop=store.createShop('保留',colors), write=storage.setItem;
 storage.setItem=()=>{throw new Error('quota');};
 assert.throws(()=>store.saveColor(shop.id,{code:'A03',hex:'#FFFFFF'}),/保存失败.*保留/);
 assert.deepEqual(store.getShop(shop.id),shop);
 storage.setItem=write;assert.equal(store.saveColor(shop.id,{code:'A03',hex:'#FFFFFF'}).colors.length,3);
});

test('corrupt storage is not silently overwritten and an intentionally empty catalogue stays empty',()=>{
 const storage=memoryStorage();storage.setItem('bead-studio-host-colors-v1','broken');const store=make(storage);
 assert.match(store.getError(),/读取失败/);assert.throws(()=>store.createShop('新色卡'),/读取失败/);assert.equal(storage.getItem('bead-studio-host-colors-v1'),'broken');
 const clean=memoryStorage(), empty=make(clean);empty.deleteShop('shop-demo');assert.deepEqual(make(clean).listShops(),[]);
});
