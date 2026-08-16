// SOOP(구 아프리카TV) 채팅 웹소켓 프로토콜 헬퍼
//
// 이 모듈은 SOOP 공식 문서가 아니라, 공개된 비공식 오픈소스 구현체(soop4j, MIT 라이선스)의
// 패킷 포맷을 참고해서 Node.js용으로 옮긴 것입니다. SOOP이 언제든 프로토콜을 바꿀 수 있어서
// 갑자기 안 될 수도 있다는 점 감안해주세요.

const STARTER = '\x1b\t'; // 패킷 시작 바이트 (ESC + TAB)
const SEP = '\f'; // 필드 구분자 (form feed)

const ChatType = {
  PING: '0000',
  CONNECT: '0001',
  ENTER_CHAT_ROOM: '0002',
  EXIT: '0004',
  CHAT: '0005',
  DISCONNECT: '0007',
  TEXT_DONATION: '0018',
  AD_BALLOON_DONATION: '0087',
  SUBSCRIBE: '0093',
  NOTIFICATION: '0104',
  VIDEO_DONATION: '0105',
  EMOTICON: '0109',
  VIEWER: '0127',
};

function buildPacket(code, payload) {
  const len = Buffer.byteLength(payload, 'utf8');
  const lengthStr = String(len).padStart(6, '0');
  return STARTER + code + lengthStr + '00' + payload;
}

function buildConnectPacket() {
  const payload = SEP.repeat(3) + '16' + SEP;
  return buildPacket(ChatType.CONNECT, payload);
}

function buildJoinPacket(chatNo) {
  const payload = SEP + chatNo + SEP.repeat(5);
  return buildPacket(ChatType.ENTER_CHAT_ROOM, payload);
}

function buildPingPacket() {
  return buildPacket(ChatType.PING, SEP);
}

function parseMessageType(packet) {
  if (!packet.startsWith(STARTER) || packet.length < 6) return null;
  return packet.substring(2, 6);
}

function splitPayload(packet) {
  return packet.split(SEP);
}

// 방송 상태/채팅 접속 정보 조회 (공개 API, 로그인 불필요)
async function fetchLiveDetail(streamerId) {
  const url = `https://live.sooplive.co.kr/afreeca/player_live_api.php?bjid=${encodeURIComponent(streamerId)}`;
  const body = new URLSearchParams({
    bid: streamerId,
    type: 'live',
    pwd: '',
    player_type: 'html5',
    stream_type: 'common',
    quality: 'HD',
    mode: 'landing',
    from_api: '0',
    is_revive: 'false',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // SOOP이 브라우저가 아닌 요청(User-Agent 없음)에는 시청자수 등
      // 일부 값을 실제값 대신 고정 기본값으로 주는 것으로 보여서, 브라우저처럼 보이게 헤더를 채움
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Referer: `https://play.sooplive.co.kr/${streamerId}`,
      Origin: 'https://play.sooplive.co.kr',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`player_live_api 요청 실패: HTTP ${res.status}`);
  }

  const json = await res.json();
  const ch = json.CHANNEL;
  if (!ch) throw new Error('CHANNEL 정보 없음 (bjid 확인 필요)');

  return {
    isOnline: Number(ch.RESULT) !== 0,
    streamerId: ch.BJID,
    streamerNick: ch.BJNICK,
    title: ch.TITLE,
    broadcastNo: ch.BNO,
    category: ch.CATE,
    chatNo: ch.CHATNO,
    viewerCount: Number(ch.CTUSER) || 0,
    chatDomain: ch.CHDOMAIN,
    chatPort: ch.CHPT,
  };
}

module.exports = {
  ChatType,
  STARTER,
  SEP,
  buildConnectPacket,
  buildJoinPacket,
  buildPingPacket,
  parseMessageType,
  splitPayload,
  fetchLiveDetail,
};
