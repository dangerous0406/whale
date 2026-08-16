// 고래상사 크루 미니 대시보드 - 서버
// crew.js에 등록된 멤버들을 동시에 추적합니다.
// 사용법: node server.js
// http://localhost:3000 에서 대시보드 확인

const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const {
  ChatType,
  buildConnectPacket,
  buildJoinPacket,
  buildPingPacket,
  parseMessageType,
  splitPayload,
  fetchLiveDetail,
} = require('./soopProtocol');

const crew = require('./crew').filter((m) => m.id && m.id.trim() !== '');
const PORT = process.env.PORT || 3000;

if (crew.length === 0) {
  console.error('crew.js에 아이디가 채워진 멤버가 하나도 없어요. crew.js를 먼저 채워주세요.');
  process.exit(1);
}

// 멤버별 상태를 담는 맵 (key: streamerId)
const states = new Map();
// 멤버별 웹소켓/타이머/접속자셋 등 내부 연결 상태 (key: streamerId)
const conns = new Map();

let todayKey = new Date().toISOString().slice(0, 10);

function initState(member) {
  states.set(member.id, {
    streamerId: member.id,
    displayName: member.name,
    isOnline: false,
    title: null,
    rawViewerCount: 0, // SOOP 공식 표시값 (부정확할 수 있음, 참고용)
    chatViewerCount: 0, // 채팅 소켓 입장/퇴장으로 직접 센 접속자 수
    chatConnected: false,
    todayBalloonTotal: 0,
    chatMessageCount: 0,
    recentDonations: [],
    lastUpdated: null,
    lastError: null,
  });
  conns.set(member.id, {
    ws: null,
    pingTimer: null,
    entered: false,
    connectedViewerIds: new Set(),
  });
}

crew.forEach(initState);

function resetIfNewDay() {
  const key = new Date().toISOString().slice(0, 10);
  if (key !== todayKey) {
    todayKey = key;
    for (const s of states.values()) {
      s.todayBalloonTotal = 0;
      s.chatMessageCount = 0;
      s.recentDonations = [];
    }
  }
}

function pushCapped(arr, item, cap) {
  arr.unshift(item);
  if (arr.length > cap) arr.length = cap;
}

// ---- 채팅 웹소켓 연결 (멤버별) ----
function connectChat(member, liveDetail) {
  const conn = conns.get(member.id);
  const domain = liveDetail.chatDomain.toLowerCase();
  const port = Number(liveDetail.chatPort) + 1;
  const url = `wss://${domain}:${port}/Websocket/${member.id}`;

  console.log(`[${member.name}] 채팅 연결 시도: ${url}`);
  const ws = new WebSocket(url, 'chat');
  conn.ws = ws;

  ws.on('open', () => {
    console.log(`[${member.name}] 소켓 열림`);
    ws.send(buildConnectPacket());
  });

  ws.on('message', (data) => {
    const packet = data.toString('utf8');
    const type = parseMessageType(packet);
    if (!type) return;
    handlePacket(member, type, packet, liveDetail);
  });

  ws.on('close', () => {
    console.log(`[${member.name}] 채팅 연결 종료`);
    const s = states.get(member.id);
    s.chatConnected = false;
    s.chatViewerCount = 0;
    conn.entered = false;
    conn.connectedViewerIds = new Set();
    if (conn.pingTimer) clearInterval(conn.pingTimer);
  });

  ws.on('error', (err) => {
    console.error(`[${member.name}] 채팅 에러:`, err.message);
    states.get(member.id).lastError = err.message;
  });
}

function handlePacket(member, type, packet, liveDetail) {
  const parts = splitPayload(packet);
  const s = states.get(member.id);
  const conn = conns.get(member.id);

  switch (type) {
    case ChatType.CONNECT: {
      conn.connectedViewerIds = new Set();
      conn.ws.send(buildJoinPacket(liveDetail.chatNo));
      break;
    }
    case ChatType.ENTER_CHAT_ROOM: {
      conn.entered = true;
      s.chatConnected = true;
      console.log(`[${member.name}] 채팅방 입장 완료`);
      conn.pingTimer = setInterval(() => {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(buildPingPacket());
        }
      }, 60000);
      break;
    }
    case ChatType.CHAT: {
      resetIfNewDay();
      s.chatMessageCount += 1;
      break;
    }
    case ChatType.TEXT_DONATION: {
      recordDonation(member, '일반 별풍선', parts[3], Number(parts[4]) || 0);
      break;
    }
    case ChatType.VIDEO_DONATION: {
      recordDonation(member, '영상풍선', parts[4], Number(parts[5]) || 0);
      break;
    }
    case ChatType.AD_BALLOON_DONATION: {
      recordDonation(member, '애드벌룬', parts[4], Number(parts[10]) || 0);
      break;
    }
    case ChatType.VIEWER: {
      for (let i = 1; i < parts.length; i += 2) {
        if (parts[i]) conn.connectedViewerIds.add(parts[i]);
      }
      s.chatViewerCount = conn.connectedViewerIds.size;
      break;
    }
    case ChatType.EXIT: {
      const userId = parts[2];
      if (userId) conn.connectedViewerIds.delete(userId);
      s.chatViewerCount = conn.connectedViewerIds.size;
      break;
    }
    default:
      break;
  }
  s.lastUpdated = Date.now();
}

function recordDonation(member, kind, fromUsername, amount) {
  resetIfNewDay();
  const s = states.get(member.id);
  s.todayBalloonTotal += amount;
  pushCapped(s.recentDonations, { kind, fromUsername, amount, time: Date.now() }, 20);
  console.log(`[${member.name}][donation] ${kind} ${amount}개 - ${fromUsername}`);
}

// ---- 방송 상태 폴링 (멤버마다 30초 간격, 서로 약간 시간차를 둬서 요청이 몰리지 않게 함) ----
async function pollMember(member) {
  const s = states.get(member.id);
  const conn = conns.get(member.id);
  try {
    const detail = await fetchLiveDetail(member.id);
    s.isOnline = detail.isOnline;
    s.title = detail.title;
    s.rawViewerCount = detail.viewerCount;
    s.lastError = null;

    const chatIsDead = !conn.ws || conn.ws.readyState === WebSocket.CLOSED;
    if (detail.isOnline && chatIsDead) {
      connectChat(member, detail);
    }
    if (!detail.isOnline && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close();
    }
  } catch (err) {
    s.lastError = err.message;
  }
  s.lastUpdated = Date.now();
}

function startPolling() {
  crew.forEach((member, idx) => {
    // 멤버마다 시작 시점을 살짝 어긋나게 해서 API 요청이 한번에 몰리지 않도록 함
    setTimeout(() => {
      pollMember(member);
      setInterval(() => pollMember(member), 30000);
    }, idx * 800);
  });
}

startPolling();

// ---- 웹 서버 ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/stats', (req, res) => {
  res.json(crew.map((m) => states.get(m.id)));
});

app.listen(PORT, () => {
  console.log(`대시보드: http://localhost:${PORT}  (추적 멤버: ${crew.map((m) => m.name).join(', ')})`);
});
