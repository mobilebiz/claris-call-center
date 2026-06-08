let phone = '';
let btnCall;
let btnInvite;
let btnHangup;
let btnHold;
let btnTransfer;
let inputTransfer;
let currentCall;
let currentLegId;
let userId = '';
let isCallingOut = false;
let isTransferring = false;
let appUsers = [];
let userListRefreshTimer = null;
const USER_LIST_REFRESH_INTERVAL_MS = 3000;
const client = new vonageClientSDK.VonageClient();
const ringtone = new Audio('./ringtone.mp3');

window.onerror = function (msg, url, line, col, error) {
  console.error(`❌ Global Error: ${msg} at ${line}:${col}`);
  return false;
};

let isInitializing = false;

async function initClient() {
  if (isInitializing) return;
  isInitializing = true;
  console.log(`🐞 initClient started for ${userId}.`);

  try {
    console.log(`🐞 Fetching token for ${userId}...`);
    const response = await fetch(`./getToken?name=${userId}`);
    if (!response.ok) throw new Error(`トークン取得失敗: ${response.status}`);
    const data = await response.json();
    const jwt = data.jwt;

    console.log("🐞 Creating/Restoring session...");
    await client.createSession(jwt);
    console.log(`✅ Session created/restored!`);
    
    // 初期取得
    await fetchAppUsers();
    
  } catch (error) {
    console.error(`❌ Initialization Error:`, error);
    // 失敗した場合は一定時間後に再試行
    setTimeout(initClient, 5000);
  } finally {
    isInitializing = false;
  }
}

window.onload = async () => {
  console.log(`🐞 window.onload started.`);
  btnCall = document.getElementById('btnCall');
  btnInvite = document.getElementById('btnInvite');
  btnHangup = document.getElementById('btnHangup');
  btnHold = document.getElementById('btnHold');
  btnTransfer = document.getElementById('btnTransfer');
  inputTransfer = document.getElementById('inputTransfer');

  // 転送先入力にフォーカスが当たった瞬間にも最新のオペレーター一覧を取得
  inputTransfer.addEventListener('focus', () => {
    if (!inputTransfer.hidden) fetchAppUsers();
  });

  let params = new URLSearchParams(decodeURI(location.search));
  params.forEach((value, key) => {
    if (key === 'userId') userId = value;
    if (key === 'phone') {
      phone = value.charAt(0) === '0' ? '+81' + value.slice(1) : value;
      btnCall.disabled = false;
      btnCall.innerHTML = '発信';
      btnCall.hidden = false;
    }
  });

  if (!userId) {
    alert('URLパラメータ "userId" が見つかりません。');
    return;
  }

  console.log("🐞 Registering event listeners...");

  client.on('legStatusUpdate', (callId, legId, status) => {
    console.log(`🐞 [Event] legStatusUpdate: ${status}, legId: ${legId}`);

    if (!currentLegId && (status === 'ANSWERED' || status === 'IN_PROGRESS')) {
      currentLegId = legId;
      console.log(`✅ currentLegId set: ${currentLegId}`);
    }

    if (status === 'RINGING') {
      if (isCallingOut) {
        btnCall.hidden = true;
        btnHangup.innerHTML = '呼び出し中...';
        btnHangup.hidden = false;
      }
    } else if (status === 'ANSWERED') {
      btnInvite.hidden = true;
      btnHangup.innerHTML = '切断';
      btnHangup.hidden = false;
      btnHold.hidden = false;
    } else if (status === 'COMPLETED') {
      if (currentLegId && legId === currentLegId) {
        console.log(`🐞 Our leg completed. Resetting UI.`);
        resetUI();
      } else if (currentCall) {
        console.log(`🐞 Another leg completed (${legId}). Checking UI restoration.`);
        if (btnHold.innerHTML === '再開') {
          restoreActiveCallUI();
        }
      }
    }
  });

  client.on('callHangup', (callId, callQuality, reason) => {
    console.log(`🐞 [Event] callHangup: reason=${reason}`);
    resetUI();
  });

  client.on('callInvite', async (callId) => {
    console.log(`🐞 [Event] callInvite! callId:`, callId);
    isCallingOut = false;
    currentCall = callId;
    currentLegId = null;

    btnCall.hidden = true;
    btnHangup.hidden = true;
    btnHold.hidden = true;
    inputTransfer.hidden = true;
    btnTransfer.hidden = true;

    setTimeout(async () => {
      btnInvite.disabled = false;
      btnInvite.hidden = false;
      try {
        ringtone.loop = true;
        await ringtone.play();
      } catch (e) {
        console.warn("⚠️ Audio play blocked:", e.message);
      }
    }, 500);
  });

  client.on('callInviteCancel', (callId) => {
    console.log(`🐞 [Event] callInviteCancel: ${callId}`);
    resetUI();
  });

  // 再接続ロジック
  client.on('sessionDisconnected', (reason) => {
    console.warn(`⚠️ Session Disconnected: ${reason}. Attempting to reconnect...`);
    initClient();
  });

  client.on('error', (error) => {
    console.error(`❌ SDK Error:`, error);
    if (error.type === 'session') {
      initClient();
    }
  });

  // 初回初期化
  await initClient();

  // ハートビート（サーバーの生存確認と再接続のトリガー）
  setInterval(async () => {
    try {
      const ping = await fetch('./_/health');
      if (!ping.ok) throw new Error('Health check failed');
    } catch (e) {
      console.warn("⚠️ Server unreachable. Will try to re-init when back.");
      // 次のポーリングでサーバーが復帰していたら initClient が走るように導線を作る
      // または単純に定期的に initClient を呼んでもよいが、重複ガードがある。
      initClient();
    }
  }, 10000); // 10秒ごと
};

function resetUI() {
  console.log(`🐞 resetting UI and state.`);
  currentCall = null;
  currentLegId = null;
  isCallingOut = false;
  isTransferring = false;
  stopUserListAutoRefresh();

  if (phone) btnCall.hidden = false;
  btnCall.disabled = false;
  btnCall.innerHTML = '発信';
  btnInvite.hidden = true;
  btnInvite.disabled = false;
  btnHangup.hidden = true;
  btnHangup.disabled = false;
  btnHangup.innerHTML = '切断';
  btnHold.hidden = true;
  btnHold.disabled = false;
  btnHold.innerHTML = '保留';
  btnHold.classList.replace('bg-yellow-400', 'bg-gray-400');
  inputTransfer.hidden = true;
  btnTransfer.hidden = true;
  const datalist = document.getElementById('userList');
  if (datalist) datalist.innerHTML = '';
  ringtone.pause();
  ringtone.currentTime = 0;
}

async function fetchAppUsers() {
  console.log("🐞 Fetching App Users (latest)...");
  try {
    const usersRes = await fetch('./api/users');
    if (usersRes.ok) {
      appUsers = await usersRes.json();
      const datalist = document.getElementById('userList');
      if (datalist) {
        datalist.innerHTML = ''; // 既存のリストをクリア
        appUsers.forEach(u => {
          const option = document.createElement('option');
          option.value = u.name;
          option.text = u.displayName !== u.name ? `${u.displayName} (${u.name})` : u.name;
          datalist.appendChild(option);
        });
      }
      console.log(`✅ Fetched ${appUsers.length} users.`);
    }
  } catch (e) {
    console.error("⚠️ Failed to fetch users", e.message);
  }
}

function startUserListAutoRefresh() {
  if (userListRefreshTimer) return;
  console.log(`🐞 Starting user list auto-refresh (every ${USER_LIST_REFRESH_INTERVAL_MS}ms)`);
  userListRefreshTimer = setInterval(() => {
    // 転送 UI が表示されており、かつ入力中（フォーカス中）でないときだけ更新
    // フォーカス中は datalist 再構築でドロップダウンが閉じたりちらつくのを避ける
    if (
      inputTransfer &&
      !inputTransfer.hidden &&
      document.activeElement !== inputTransfer
    ) {
      fetchAppUsers();
    }
  }, USER_LIST_REFRESH_INTERVAL_MS);
}

function stopUserListAutoRefresh() {
  if (userListRefreshTimer) {
    console.log(`🐞 Stopping user list auto-refresh`);
    clearInterval(userListRefreshTimer);
    userListRefreshTimer = null;
  }
}

function restoreActiveCallUI() {
  console.log(`🐞 Restoring active call UI.`);
  isTransferring = false;
  btnHold.innerHTML = '保留';
  btnHold.classList.replace('bg-yellow-400', 'bg-gray-400');
  inputTransfer.hidden = true;
  btnTransfer.hidden = true;
  stopUserListAutoRefresh();
}

async function phoneCall() {
  try {
    isCallingOut = true;
    btnCall.disabled = true;
    btnCall.innerHTML = '準備中...';
    const callId = await client.serverCall({ to: phone });
    currentCall = callId;
    console.log('🐞 outbound call started:', callId);
  } catch (error) {
    btnCall.disabled = false;
    btnCall.innerHTML = '発信';
    console.error(`🐞 Error: ${error.message}`);
  }
}

async function invite() {
  try {
    btnInvite.disabled = true;
    btnInvite.innerHTML = '応答中...';
    ringtone.pause();
    ringtone.currentTime = 0;
    await client.answer(currentCall);
    console.log('Call answered');
    btnInvite.hidden = true;
    btnHangup.hidden = false;
    btnHold.hidden = false;
  } catch (error) {
    console.error(`🐞 Error: ${error.message}`);
    btnInvite.disabled = false;
    btnInvite.hidden = true;
  }
}

async function hangup() {
  try {
    btnHangup.disabled = true;
    btnHangup.innerHTML = '切断中...';
    await client.hangup(currentCall);
    console.log('Call ended');
    resetUI();
  } catch (error) {
    console.error(`🐞 Error: ${error.message}`);
    btnHangup.disabled = false;
    btnHangup.innerHTML = '切断';
  }
}

async function toggleHold() {
  const isHolding = btnHold.innerHTML === '再開';
  const action = isHolding ? 'unhold' : 'hold';

  try {
    console.log(`🐞 toggleHold: currentCall=${currentCall}, currentLegId=${currentLegId}, userId=${userId}`);

    if (client.session && client.session.legs) {
      const legs = Object.keys(client.session.legs);
      if (legs.length > 0 && (!currentLegId || !client.session.legs[currentLegId])) {
        currentLegId = legs[0];
      }
    }

    const body = {
      conversation_uuid: currentCall,
      leg_id: currentLegId,
      operator_user_id: userId,
      action: action
    };

    if (isHolding && isTransferring) {
      console.log(`🐞 Transfer mode detected. Calling /cancelTransfer instead of unhold.`);
      const cancelResp = await fetch('./cancelTransfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (cancelResp.ok) {
        restoreActiveCallUI();
        return;
      } else {
        const err = await cancelResp.text();
        alert('転送キャンセルに失敗しました: ' + err);
        return;
      }
    }

    const response = await fetch('./hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      if (isHolding) {
        // 通常の再開処理（ただし上記 cancelTransfer で処理されるためここには来ないはず）
        btnHold.innerHTML = '保留';
        btnHold.classList.replace('bg-yellow-400', 'bg-gray-400');
        inputTransfer.hidden = true;
        btnTransfer.hidden = true;
      } else {
        // 最新のユーザー一覧を取得してから表示
        await fetchAppUsers();
        btnHold.innerHTML = '再開';
        btnHold.classList.remove('bg-gray-400');
        btnHold.classList.add('bg-yellow-400');
        inputTransfer.hidden = false;
        btnTransfer.hidden = false;
        // 保留中は他オペレーターの状態変化に追従するため一覧を定期更新
        startUserListAutoRefresh();
      }
    } else {
      const errText = await response.text();
      alert('保留操作に失敗しました: ' + errText);
    }
  } catch (e) {
    console.error(e);
    alert('通信エラーが発生しました');
  }
}

async function transferCall() {
  const destination = inputTransfer.value.trim();
  
  if (!destination) return;

  // バリデーション：電話番号形式かどうかを簡易判定（数字や記号のみ）
  const isPhone = /^[0-9+.\-\s]+$/.test(destination);
  
  // App User 宛ての場合、一覧に存在するかチェック
  if (!isPhone && !appUsers.find(u => u.name === destination)) {
      alert(`指定されたユーザー「${destination}」は存在しません。`);
      return;
  }

  if (!confirm(`${destination} へ転送しますか？`)) return;

  try {
    const body = {
      conversation_uuid: currentCall,
      leg_id: currentLegId,
      destination_number: destination,
      operator_user_id: userId
    };

    const response = await fetch('./transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      isTransferring = true;
    } else {
      const errText = await response.text();
      console.error(`Transfer fetch failed: status=${response.status}, text=${errText}`);
      alert(`転送に失敗しました: ${response.status} ${errText}`);
    }
  } catch (e) {
    console.error('Transfer fetch error:', e);
    alert(`転送エラー: ${e.message}`);
  }
}
