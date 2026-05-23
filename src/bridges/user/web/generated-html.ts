/**
 * GENERATED FILE — do not edit.
 * Rebuild with: pnpm build:frontend
 */

export const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Comms</title>
</head>
<body>

<div id="sidebar">
  <h2>Agent Comms</h2>
  <div class="sidebar-section">
    <h3>Rooms</h3>
    <div id="room-list"></div>
    <h3>Agents</h3>
    <div id="agent-list"></div>
  </div>
</div>

<div id="main">
  <div id="header">Select a room</div>
  <div id="messages"></div>
  <div id="input-bar">
    <input id="input" type="text" placeholder="Type a message or /command..." autocomplete="off" />
    <button id="send-btn">Send</button>
  </div>
</div>

  <script>
"use strict";(()=>{var O=Object.defineProperty;var U=(e,n,t)=>n in e?O(e,n,{enumerable:!0,configurable:!0,writable:!0,value:t}):e[n]=t;var m=(e,n,t)=>U(e,typeof n!="symbol"?n+"":n,t);document.head.appendChild(Object.assign(document.createElement("style"),{textContent:\`:root {
  --bg: #1a1a2e;
  --surface: #16213e;
  --border: #0f3460;
  --text: #e4e4e4;
  --dim: #888;
  --accent: #00b4d8;
  --green: #06d6a0;
  --red: #ef476f;
  --yellow: #ffd166;
  --purple: #b5838d;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  display: flex;
}
#sidebar {
  width: 260px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#sidebar h2 {
  padding: 12px 16px;
  font-size: 14px;
  color: var(--accent);
  border-bottom: 1px solid var(--border);
}
.sidebar-section {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.sidebar-section h3 {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--dim);
  padding: 8px 8px 4px;
}
.room-item, .agent-item {
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.room-item:hover, .agent-item:hover { background: rgba(255,255,255,0.05); }
.room-item.active { background: var(--border); }
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.active { background: var(--green); }
.status-dot.idle { background: var(--yellow); }
.status-dot.busy { background: var(--red); }
.status-dot.offline { background: var(--dim); }
#main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#header {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  font-size: 15px;
  font-weight: 600;
  background: var(--surface);
}
#messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.msg {
  font-size: 13px;
  line-height: 1.5;
}
.msg .sender { font-weight: 600; color: var(--accent); }
.msg .time { color: var(--dim); font-size: 11px; margin-left: 8px; }
.msg.system { color: var(--dim); font-style: italic; }
.msg.status { color: var(--yellow); font-size: 12px; }
.msg.dm { color: var(--purple); }
.msg .dm-badge {
  background: var(--purple);
  color: #fff;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
}
#input-bar {
  display: flex;
  padding: 12px 20px;
  gap: 8px;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
#input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
#input:focus { border-color: var(--accent); }
#send-btn {
  background: var(--accent);
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
#send-btn:hover { opacity: 0.9; }
#empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  font-size: 14px;
}
\`}));function q(e){return typeof e=="object"&&e!==null}function K(e){return Array.isArray(e)}function J(e){return Array.isArray(e)}function B(e){return Array.isArray(e)}function G(e){return q(e)&&typeof e.type=="string"}async function M(){let n=await(await fetch("/api/agents")).json();if(!K(n))throw new Error("Invalid agents response");return n}async function A(){let n=await(await fetch("/api/rooms")).json();if(!J(n))throw new Error("Invalid rooms response");return n}async function C(e,n){let t=n?\`/api/rooms/\${encodeURIComponent(e)}/messages?since=\${encodeURIComponent(n)}\`:\`/api/rooms/\${encodeURIComponent(e)}/messages\`,s=await(await fetch(t)).json();if(!B(s))throw new Error("Invalid messages response");return s}var f=class{constructor(n){m(this,"ws");m(this,"reconnectTimer");m(this,"handler");this.handler=n}connect(){let n=location.protocol==="https:"?"wss:":"ws:",t=new WebSocket(\`\${n}//\${location.host}\`);this.ws=t,t.onopen=()=>{this.handler.onOpen?.()},t.onclose=()=>{this.handler.onClose?.(),this.scheduleReconnect()},t.onerror=()=>{},t.onmessage=o=>{let s=JSON.parse(typeof o.data=="string"?o.data:String(o.data));G(s)&&this.handler.onFrame?.(s)}}sendAction(n){let t=this.ws;t?.readyState===WebSocket.OPEN&&t.send(JSON.stringify(n))}disconnect(){this.reconnectTimer!==void 0&&(clearTimeout(this.reconnectTimer),this.reconnectTimer=void 0);let n=this.ws;n&&n.close(),this.ws=void 0}scheduleReconnect(){this.reconnectTimer=setTimeout(()=>{this.connect()},3e3)}};function l(e,n,t){let o=e.querySelector(n);if(!o)throw new Error(\`Required element not found: \${n}\`);if(t&&o.tagName.toLowerCase()!==t)throw new Error(\`Element \${n} must be <\${t}>, got <\${o.tagName.toLowerCase()}>\`);return o}function p(e,n){let t=e.createElement("div");return t.textContent=n,t.innerHTML}function \$(e,n,t,...o){let s=e.createElement(n);if(t)for(let[r,a]of Object.entries(t))s.setAttribute(r,a);for(let r of o)typeof r=="string"?s.appendChild(e.createTextNode(r)):s.appendChild(r);return s}function h(e){e.innerHTML=""}function k(e){return e.slice(11,19)}function L(e,n,t){let o=e.trim();return o.length===0?{kind:"ignored"}:o.startsWith("/")?Q(o,n):n?{kind:"action",action:{action:"send",target:n,content:o}}:t?{kind:"action",action:{action:"dm",target:t,content:o}}:{kind:"local",result:{type:"error",text:"Join a room or select an agent first"}}}function Q(e,n){let t=e.slice(1).split(/\\s+/),o=(t[0]??"").toLowerCase();switch(o){case"join":return t[1]?{kind:"action",action:{action:"join_room",room:t[1]}}:{kind:"local",result:{type:"error",text:"Usage: /join <room>"}};case"leave":return{kind:"action",action:{action:"leave_room",room:t[1]??n??""}};case"rooms":return{kind:"action",action:{action:"list_rooms"}};case"agents":return{kind:"action",action:{action:"list_agents"}};case"dm":return!t[1]||!t[2]?{kind:"local",result:{type:"error",text:"Usage: /dm <agent> <message>"}}:{kind:"action",action:{action:"dm",target:t[1],content:t.slice(2).join(" ")}};case"create":return t[1]?{kind:"action",action:{action:"create_room",name:t[1],type:"public"}}:{kind:"local",result:{type:"error",text:"Usage: /create <name>"}};case"destroy":return t[1]?{kind:"action",action:{action:"destroy_room",room:t[1]}}:{kind:"local",result:{type:"error",text:"Usage: /destroy <room>"}};case"help":return{kind:"local",result:{type:"help",text:"Commands: /join, /leave, /rooms, /agents, /dm, /create, /destroy, /help"}};default:return{kind:"local",result:{type:"unknown",text:\`Unknown command: /\${o}\`}}}}function S(e,n,t,o,s){let r=k(s),a=e.createElement("div");a.className="msg",a.innerHTML=\`<span class="sender">\${p(e,t)}</span><span class="time">\${r}</span>: \${p(e,o)}\`,n.messagesEl.appendChild(a),n.messagesEl.scrollTop=n.messagesEl.scrollHeight}function V(e,n,t,o,s){let r=k(s),a=e.createElement("div");a.className="msg dm",a.innerHTML=\`<span class="dm-badge">DM</span> <span class="sender">\${p(e,t)}</span><span class="time">\${r}</span>: \${p(e,o)}\`,n.messagesEl.appendChild(a),n.messagesEl.scrollTop=n.messagesEl.scrollHeight}function c(e,n,t){let o=e.createElement("div");o.className="msg system",o.textContent=t,n.messagesEl.appendChild(o),n.messagesEl.scrollTop=n.messagesEl.scrollHeight}function y(e,n,t){let o=e.createElement("div");o.className="msg status",o.textContent=t,n.messagesEl.appendChild(o),n.messagesEl.scrollTop=n.messagesEl.scrollHeight}function w(e){h(e.messagesEl)}function H(e,n,t,o){switch(t.type){case"room_message":o===t.message.room&&S(e,n,t.message.from,t.message.content,t.message.timestamp);break;case"dm":V(e,n,t.message.from,t.message.content,t.message.timestamp);break;case"member_joined":c(e,n,\`\${t.agent} joined \${t.room}\`);break;case"member_left":c(e,n,\`\${t.agent} left \${t.room}\`);break;case"member_status":y(e,n,\`\${t.agent} is now \${t.status} in \${t.room}\`);break;case"delivery_status":y(e,n,\`Message \${t.messageId} \${t.status} by \${t.agent}\`);break;case"room_members":if(o===t.room){let s=t.members.map(r=>\`\${r.name} (\${r.status})\`).join(", ");c(e,n,\`Members: \${s}\`)}break;case"room_invite":{let s=t.roomDescription?\` \\u2014 \${t.roomDescription}\`:"";c(e,n,\`\${t.fromName} invited you to "\${t.room}"\${s}\`);break}case"invite_declined":c(e,n,\`\${t.agentName} declined invite to \${t.room}: "\${t.reason}"\`);break}}function N(e,n,t,o,s){h(n.roomListEl);for(let r of t){let a=o===r.id,E=r.type.charAt(0).toUpperCase(),F=r.members.length,g=e.createElement("div");g.className=\`room-item\${a?" active":""}\`,g.innerHTML=\`\${E} \${p(e,r.name)} <span style="color:var(--dim)">(\${String(F)})</span>\`,g.onclick=()=>{s(r.id)},n.roomListEl.appendChild(g)}}function j(e,n,t,o){h(n.agentListEl);for(let s of t){let r=e.createElement("div");r.className="agent-item";let a=\$(e,"span",{class:\`status-dot \${s.status}\`}),E=e.createTextNode(\` \${s.name}\`);r.appendChild(a),r.appendChild(E),o&&(r.onclick=()=>{o(s.id)}),n.agentListEl.appendChild(r)}}function x(e,n){e.headerEl.textContent=n}function D(e,n,t){for(let o of t)S(e,n,o.from,o.content,o.timestamp)}var _={currentRoom:void 0,dmTarget:void 0,agents:[],rooms:[],connected:!1},b=class{constructor(){m(this,"state",{..._});m(this,"listeners",new Set)}subscribe(n){return this.listeners.add(n),()=>{this.listeners.delete(n)}}get(){return this.state}setCurrentRoom(n){this.state={...this.state,currentRoom:n},this.notify()}setDmTarget(n){this.state={...this.state,dmTarget:n},this.notify()}setAgents(n){this.state={...this.state,agents:n},this.notify()}setRooms(n){this.state={...this.state,rooms:n},this.notify()}setConnected(n){this.state={...this.state,connected:n},this.notify()}applyState(n,t){this.state={...this.state,agents:n,rooms:t},this.notify()}reset(){this.state={..._},this.notify()}notify(){let n=this.state;for(let t of this.listeners)t(n)}};var X=l(document,"#messages"),u=l(document,"#input","input"),R=l(document,"#header"),Y=l(document,"#room-list"),Z=l(document,"#agent-list"),d={messagesEl:X},I={roomListEl:Y,agentListEl:Z},i=new b;i.subscribe(e=>{N(document,I,e.rooms,e.currentRoom,ne),j(document,I,e.agents,te)});var P=new f({onOpen:()=>{i.setConnected(!0),c(document,d,"Connected to mesh")},onClose:()=>{i.setConnected(!1),c(document,d,"Disconnected \\u2014 reconnecting...")},onFrame:ee});function ee(e){switch(e.type){case"delivery":H(document,d,e.event,i.get().currentRoom),(e.event.type==="member_joined"||e.event.type==="member_left"||e.event.type==="member_status")&&T();break;case"result":if(c(document,d,e.result.content),!e.result.isError){if(v?.action==="join_room"&&!i.get().currentRoom){let n=v.room;i.setDmTarget(void 0),i.setCurrentRoom(n),x({headerEl:R},n)}T()}v=void 0;break;case"error":y(document,d,\`Error: \${e.message}\`);break;case"state":i.applyState(e.agents,e.rooms);break}}var v;function W(e){v=e,P.sendAction(e)}async function T(){let[e,n]=await Promise.all([M(),A()]);i.setAgents(e),i.setRooms(n)}async function ne(e){i.setDmTarget(void 0),i.setCurrentRoom(e),x({headerEl:R},e),w(d),W({action:"join_room",room:e});let n=await C(e);D(document,d,n),c(document,d,\`Joined \${e}\`),u.focus()}function te(e){i.setCurrentRoom(void 0),i.setDmTarget(e),w(d),x({headerEl:R},\`DM with \${e}\`),u.focus()}function z(){let e=u.value;u.value="";let n=L(e,i.get().currentRoom,i.get().dmTarget);switch(n.kind){case"action":W(n.action);break;case"local":c(document,d,n.result.text);break;case"ignored":break}}var oe=l(document,"#send-btn");oe.onclick=z;u.addEventListener("keydown",e=>{e.key==="Enter"&&z()});P.connect();T();u.focus();})();

  </script>
</body>
</html>
`;
