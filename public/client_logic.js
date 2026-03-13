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
const client = new vonageClientSDK.VonageClient();
const ringtone = new Audio('./ringtone.mp3');

window.onerror = function(msg, url, line, col, error) {
  console.error(`❌ Global Error: ${msg} at ${line}:${col}`);
  return false;
};

window.onload = async () => {
  console.log(`🐞 window.onload started.`);
  btnCall = document.getElementById('btnCall');
  btnInvite = document.getElementById('btnInvite');
  btnHangup = document.getElementById('btnHangup');
  btnHold = document.getElementById('btnHold');
  btnTransfer = document.getElementById('btnTransfer');
  inputTransfer = document.getElementById('inputTransfer');

  try {
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
      throw new Error('URLパラメータ "userId" が見つかりません。');
    }

    console.log(`🐞 Fetching token for ${userId}...`);
    const response = await fetch(`./getToken?name=${userId}`);
    if (!response.ok) throw new Error(`トークン取得失敗: ${response.status}`);
    const data = await response.json();
    const jwt = data.jwt;

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
      
      btnInvite.disabled = false;
      btnInvite.hidden = false;
      try {
        ringtone.loop = true;
        await ringtone.play();
      } catch (e) {
        console.warn("⚠️ Audio play blocked:", e.message);
      }
    });

    client.on('callInviteCancel', (callId) => {
      console.log(`🐞 [Event] callInviteCancel: ${callId}`);
      resetUI();
    });

    console.log("🐞 Creating session...");
    await client.createSession(jwt);
    console.log(`✅ Session created!`);
    
  } catch (error) {
    console.error(`❌ Initialization Error:`, error);
    alert(`初期化エラー: ${error.message}`);
  }
};

function resetUI() {
  console.log(`🐞 resetting UI and state.`);
  currentCall = null;
  currentLegId = null;
  isCallingOut = false;
  
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
  ringtone.pause();
  ringtone.currentTime = 0;
}

function restoreActiveCallUI() {
  console.log(`🐞 Restoring active call UI.`);
  btnHold.innerHTML = '保留';
  btnHold.classList.replace('bg-yellow-400', 'bg-gray-400');
  inputTransfer.hidden = true;
  btnTransfer.hidden = true;
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

        if (isHolding) {
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
                btnHold.innerHTML = '再開';
                btnHold.classList.remove('bg-gray-400');
                btnHold.classList.add('bg-yellow-400');
                inputTransfer.hidden = false;
                btnTransfer.hidden = false;
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
    const destination = inputTransfer.value;
    if (!destination || !confirm(`${destination} へ転送しますか？`)) return;

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

        if (!response.ok) {
            alert('転送に失敗しました');
        }
    } catch (e) {
        console.error(e);
        alert('転送エラー');
    }
}
