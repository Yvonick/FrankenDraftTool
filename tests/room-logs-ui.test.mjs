import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../services/frontend/room-logs.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.className = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  get lastElementChild() { return this.children.at(-1); }
  get classList() { return { add: name => { this.className += ` ${name}`; } }; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (sequence, extra = {}) => ({sequence, at:Date.now(), kind:'bag_pick', actor:'Alice', ...extra});
const state = {visible:true, roomNumber:'123456', viewerId:'observer', revision:1, status:'active', revealPicks:true};
function fixture() {
  const nodes = new Map(['#room-log-events', '#room-logs-status', '#room-logs-more'].map(id => [id, new Element()]));
  const requests = [];
  const context = { window:{addEventListener(){}}, document:{querySelector: id=>nodes.get(id), createElement: tag=>new Element(tag)},
    latestRoom:null, URLSearchParams, AbortController, apiUrl: value=>value,
    apiFetch: (path, options) => new Promise(resolve=>requests.push({path, signal:options.signal, finish(data, ok=true) {resolve({ok,json:async()=>data});}})) };
  vm.runInNewContext(source,context);
  return {update:context.window.frankenRoomLogs.update, requests, list:nodes.get('#room-log-events'), status:nodes.get('#room-logs-status'), more:nodes.get('#room-logs-more')};
}
const page = (events, extra={}) => ({draftId:'draft-1',events,nextAfter:null,revealPicks:true,...extra});
const text = node => [node.textContent,...node.children.map(text)].join(' ');

test('room logs load only on demand and append updates without replacing the read position', async()=>{
  const ui=fixture();
  ui.update({...state,visible:false}); assert.equal(ui.requests.length,0);
  ui.update(state); ui.requests[0].finish(page([event(1)])); await tick();
  const first=ui.list.children[0];
  ui.update(state); assert.equal(ui.requests.length,1);
  ui.update({...state,revision:2}); assert.match(ui.requests[1].path,/after=1/);
  ui.requests[1].finish(page([event(2,{kind:'undo',targetSequence:1})])); await tick();
  assert.equal(ui.list.children[0],first);
  assert.match(first.className,/is-undone/);
  assert.match(text(first),/Undone by #2/);
});

test('revoking visibility immediately clears private logs and ignores delayed private responses', async()=>{
  const ui=fixture(); ui.update(state);
  ui.update({...state,revealPicks:false,revision:2});
  assert.equal(ui.requests[0].signal.aborted,true);
  assert.equal(ui.list.children.length,0);
  ui.requests[0].finish(page([event(1,{items:[{name:'Secret'}]})])); await tick();
  assert.equal(ui.list.children.length,0);
  ui.requests[1].finish(page([event(1,{itemCount:2})],{revealPicks:false})); await tick();
  assert.doesNotMatch(text(ui.list),/Secret/);
  assert.match(text(ui.list),/2 items picked \(private\)/);
});

test('pagination remains usable after leaving logs mid-request, and a restarted draft clears old events', async()=>{
  const ui=fixture(); ui.update(state);
  ui.requests[0].finish(page([event(1)],{nextAfter:1})); await tick();
  ui.more.listeners.click(); assert.equal(ui.more.disabled,true);
  ui.update({...state,visible:false}); assert.equal(ui.more.disabled,false);
  ui.requests[1].finish(page([event(2)])); await tick();
  assert.equal(ui.list.children.length,1);
  ui.update({...state,revision:2}); ui.more.listeners.click();
  ui.requests[2].finish(page([],{draftId:'draft-2'})); await tick();
  assert.equal(ui.list.children.length,0);
  assert.match(ui.requests[3].path,/after=0/);
  ui.requests[3].finish(page([event(1,{kind:'draft_started'})],{draftId:'draft-2'})); await tick();
  assert.equal(ui.list.children.length,1);
  assert.match(text(ui.list),/Started the draft/);
});

test('failed log reads offer retry and superseded room requests cannot populate another room', async()=>{
  const ui=fixture(); ui.update(state);
  ui.requests[0].finish({},false); await tick();
  assert.equal(ui.more.textContent,'Retry'); assert.equal(ui.more.disabled,false);
  ui.more.listeners.click(); ui.update({...state,roomNumber:'654321'});
  ui.requests[1].finish(page([event(1,{actor:'Wrong room'})])); await tick();
  assert.equal(ui.list.children.length,0);
  ui.requests[2].finish(page([event(1,{actor:'Correct room'})])); await tick();
  assert.doesNotMatch(text(ui.list),/Wrong room/); assert.match(text(ui.list),/Correct room/);
});
