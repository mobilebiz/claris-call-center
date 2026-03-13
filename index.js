import { Voice, vcr } from '@vonage/vcr-sdk';
import { Vonage } from '@vonage/server-sdk';
import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import axios from 'axios';
import fs from 'fs';

const app = express();
const router = express.Router();
expressWs(router);
const port = process.env.VCR_PORT;
const vonage = new Vonage(
    {
        applicationId: process.env.API_APPLICATION_ID,
        privateKey: process.env.PRIVATE_KEY
    }
);

const CLARIS_SERVER = process.env.CLARIS_SERVER_URL;   // Claris FileMaker ServerのURL
const BASIC_AUTH = Buffer.from(`${process.env.USER}:${process.env.PASS}`).toString('base64');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

const session = vcr.createSession();
const voice = new Voice(session);

// セッション内で着信があった場合に呼び出す関数を定義
await voice.onCall('onCall');
// セッション内のイベントが発生した場合の関数を定義
await voice.onCallEvent({ callback: 'onEvent' });

/**
 * ヘルスチェック用エンドポイント
 */
app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

/**
 * メトリクス取得用エンドポイント
 */
app.get('/_/metrics', async (req, res) => {
    res.sendStatus(200);
});

/**
 * 電話番号からフリガナ情報を取得するAPI
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.post('/getKana', async (req, res, next) => {
    console.log(`🐞 getKana called`);
    const number = req.body.number ? req.body.number.replace(/^81/, '0') : '';  // 電話番号をOABJに変換
    if (!number) {
        res.sendStatus(400);
        return;
    }
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        const response = await axios.get(`${CLARIS_SERVER}/Customer?$top=1&$select=LastName_Furigana, FirstName_Furigana&$filter=TelNo eq '${number}'`, { headers });
        const value = response.data.value || [];
        const kana = value[0] ? `${value[0].LastName_Furigana || ''} ${value[0].FirstName_Furigana || ''}` : '';
        res.json({ kana });
    } catch (e) {
        next(e);
    }
    res.sendStatus(200);
});

/**
 * JWT認証トークンを取得するAPI
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.get('/getToken', async (req, res, next) => {
    try {
        let user;
        // オペレーター名の取得
        const name = req.query.name || 'Operator';
        try {
            // すでにユーザーが存在するかを確認
            const users = await vonage.users.getUserPage({ name });
            // 既存ユーザーを流用
            user = users._embedded.users[0]
        } catch (e) {
            console.log('user not found');
            // ユーザーの新規作成
            user = await vonage.users.createUser(
                {
                    id: name,
                    name,
                    displayName: name
                }
            );
        }

        // JWTの作成
        const jwt = generateJWT(user.name);
        res.json({
            jwt: jwt
        });
    } catch (e) {
        console.error(e);
        next(e);
    }
});

/**
 * キューイングデータの登録
 * @param {Object} body - リクエストボディ
 * @param {string} status - ステータス（デフォルト: 'ENQUEUE'）
 * @returns {Promise<boolean>} 登録成功時はtrue、失敗時はfalse
 */
const putQueue = async (body, status = 'ENQUEUE') => {
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        const data = {
            Conversation_uuid: body.conversation_uuid,
            IncomingNumber: body.from ? body.from.replace(/^\+?81/, '0') : body.to.replace(/^\+?81/, '0'),
            Status: status,
            Type: status === 'ENQUEUE' ? 'INCOMING' : 'OUTGOING'
        }
        await axios.post(`${CLARIS_SERVER}/QueueData`, data, { headers });
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

/**
 * オペレーターのピックアップ
 * @returns {Promise<string>} オペレーターのユーザーID
 */
const pickupOperator = async () => {
    console.log('🐞 pickupOperator called');
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        const response = await axios.get(
            `${CLARIS_SERVER}/Operator_Status?$top=1&$select=UserID&$filter=Status eq '待受中'&$orderby=LastCallTime asc`,
            { headers }
        );
        console.dir(response.data);
        const value = response.data.value || [];
        return value[0] ? value[0].UserID : '';
    } catch (e) {
        console.error(e);
        throw e;
    }
}

/**
 * オペレーターのステータス変更
 * @param {string} conversationId - 会話ID
 * @param {string} incomingNumber - 着信番号
 * @param {string} status - ステータス
 * @param {string} userId - ユーザーID
 * @returns {Promise<boolean>} 更新成功時はtrue
 */
const updateOperatorStatus = async (conversationId, incomingNumber, status, userId) => {
    console.log(`🐞 updateOperatorStatus called ${status}`);
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        const data = {
            Status: status,
            IncomingNumber: incomingNumber.replace(/^\+?81/, '0'),
            Conversation_uuid: conversationId
        }
        await axios.patch(`${CLARIS_SERVER}/Operator_Status?$filter=UserID eq '${userId}'`, data, { headers });
        return true;
    } catch (e) {
        console.error(e);
        throw e;
    }
}

/**
 * ウェイト処理（ｍｓ）
 * @param {number} ms - 待機時間（ミリ秒）
 * @returns {Promise<void>}
 */
const wait = async (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 着信のイベントハンドラ
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.post('/onCall', async (req, res, next) => {
    console.log(`🐞 onCall called via ${req.body.from ? req.body.from : req.body.from_user}`);
    try {
        if (req.body.from) { // PSTN経由の着信
            // キューイングデータの登録
            putQueue(req.body, 'ENQUEUE');
            // オペレーターのピックアップ
            const userId = await pickupOperator();
            if (userId) { // オペレーターが見つかった場合
                // オペレーターのステータス変更
                updateOperatorStatus(req.body.conversation_uuid, req.body.from, '着信中', userId);
                // ウェイト処理
                // await wait(3000);
                res.json([
                    {
                        action: 'record',
                        eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEventRecorded`],
                        split: 'conversation',
                        transcription: {
                            language: 'ja-JP',
                            eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEventTranscribed`],
                            // sentimentAnalysis: true
                        },
                    },
                    {
                        action: 'connect',
                        eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEvent?userId=${userId}`],
                        from: req.body.from,
                        endpoint: [{
                            type: 'app',
                            user: userId
                        }]
                    }
                ]);
            } else { // オペレーターが見つからなかった場合
                res.json([
                    {
                        action: 'talk',
                        text: '申し訳ございませんが、現在対応できるオペレーターがいません。後ほどおかけ直しください。',
                        language: 'ja-JP',
                        voice: 3,
                        premium: true
                    }
                ]);
            }
        } else { // WebRTC経由の着信
            const userId = req.body.from_user;
            // 履歴データの登録
            putQueue(req.body, 'CALLING');
            // オペレーターのステータス変更
            updateOperatorStatus(req.body.conversation_uuid, req.body.to, '発信中', req.body.from_user);
            res.json([
                {
                    action: 'record',
                    eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEventRecorded`],
                    split: 'conversation',
                    transcription: {
                        language: 'ja-JP',
                        eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEventTranscribed`],
                        // sentimentAnalysis: true
                    },
                },
                {
                    action: 'connect',
                    eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEvent?userId=${userId}`],
                    from: process.env.VONAGE_NUMBER,
                    endpoint: [{
                        type: 'phone',
                        number: req.body.to
                    }]
                }
            ]);
        }
    } catch (e) {
        next(e);
    }
});

/**
 * イベント発生時のイベントハンドラー
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.post('/onEvent', async (req, res, next) => {
    console.log(`🐞 onEvent called`);
    try {
        console.log('🐞 userId is: ', req.query.userId || '');
        console.log('🐞 event status is: ', req.body.status);
        console.log('🐞 event direction is: ', req.body.direction);
        // 応答時の処理
        if (req.body.status === 'answered' && req.body.direction === 'outbound') {
            // if (req.body.status === 'answered') {
            // オペレーターのステータス変更
            await updateOperatorStatus(req.body.conversation_uuid, req.body.from, '通話中', req.query.userId);
        }
        // 通話終了時の処理
        if (req.body.status === 'completed' && req.body.direction === 'outbound') {
            // オペレーターのステータス変更
            await updateOperatorStatus(req.body.conversation_uuid, '', '待受中', req.query.userId);
        }
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

/**
 * 録音データをファイルに保存
 * @param {string} conversation_uuid - 会話UUID
 * @param {string} recording_url - 録音データのURL
 * @returns {Promise<void>}
 */
async function saveRecordFile(conversation_uuid, recording_url) {
    return new Promise(async (resolve, reject) => {
        const jwt = generateJWT();
        const config = {
            headers: {
                Authorization: `Bearer ${jwt}`
            },
            responseType: 'stream'
        };
        let response = await axios.get(recording_url, config);
        console.log(`🐞 Recording file stream got.`);
        const tmp_file_path = `./public/tmp/${conversation_uuid}.mp3`;
        const writer = fs.createWriteStream(tmp_file_path);
        response.data.pipe(writer);
        writer.on('finish', () => {
            console.log(`🐞 Recording file stream saved.`);
            resolve();
        });
        writer.on('error', (error) => {
            console.log(error);
            reject(error);
        })
    })
}

/**
 * 録音終了時のイベントハンドラー
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.post('/onEventRecorded', async (req, res, next) => {
    console.log(`🐞 onEventRecorded called`);
    try {
        // 録音データの保存
        await saveRecordFile(req.body.conversation_uuid, req.body.recording_url);
        const recordingUrl = `${process.env.VCR_INSTANCE_PUBLIC_URL}/tmp/${req.body.conversation_uuid}.mp3`;
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        const data = {
            scriptParameterValue: `${req.body.conversation_uuid}||${recordingUrl}`
            // conversation_uuid: req.body.conversation_uuid,
            // recording_url: recordingUrl,
            // customer_id: ''
        }

        const response = await axios.post(
            `${CLARIS_SERVER}/Script.GetRecordedFile`,
            data,
            { headers }
        );

        // const response = await axios.post(END_POINT_RECORDING, data);
        console.log(`🐞 response data: ${JSON.stringify(response.data)}`)
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

/**
 * 音声認識データを取得
 * @param {string} transcription_url - 音声認識データのURL
 * @returns {Promise<string>} フォーマットされた音声認識テキスト
 */
async function getTranscribedData(transcription_url) {
    return new Promise(async (resolve, reject) => {
        const jwt = generateJWT();
        const config = {
            headers: {
                Authorization: `Bearer ${jwt}`
            }
        };
        try {
            const response = await axios.get(transcription_url, config);
            // console.log(`🐞 response.data: ${JSON.stringify(response.data)}`);
            const agentSentences = response.data.channels[1]?.transcript;
            const userSentences = response.data.channels[0]?.transcript;
            let transcripts = [];
            if (agentSentences) {
                agentSentences.forEach((agentSentence) => {
                    transcripts.push({
                        ...agentSentence,
                        speaker: 'agent',
                    });
                });
            }
            if (userSentences) {
                userSentences.forEach((userSentence) => {
                    transcripts.push({
                        ...userSentence,
                        speaker: 'user',
                    });
                });
            }
            // timestampでソートする
            transcripts.sort((a, b) => {
                if (a.timestamp < b.timestamp) return -1;
                if (a.timestamp > b.timestamp) return 1;
                return 0;
            });
            let transcript = '';
            transcripts.forEach((t) => {
                if (t.speaker === 'agent') {
                    transcript += `[担当] ${t.sentence || ''}\n`;
                } else if (t.speaker === 'user') {
                    transcript += `[お客様] ${t.sentence || ''}\n`;
                }
            });
            console.log(`🐞 transcript: ${transcript}`);
            resolve(transcript);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 音声認識終了時のイベントハンドラー
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.post('/onEventTranscribed', async (req, res, next) => {
    console.log(`🐞 onEventTranscribed called`);
    try {
        // 音声認識データの取得
        const transcript = await getTranscribedData(req.body.transcription_url);
        console.log(`🐞 transcript: ${transcript}`);
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        const data = {
            conversation_uuid: req.body.conversation_uuid,
            LLM: transcript,
            CustomerNo: ''
        }
        const response = await axios.post(
            `${CLARIS_SERVER}/TranscriptionData`,
            data,
            { headers }
        );

        // const response = await axios.post(END_POINT_TRANSCRIPTION, data);
        console.log(`🐞 response data: ${JSON.stringify(response.data)}`)
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

/**
 * JWTの生成
 * @param {string} username - ユーザー名（オプション）
 * @returns {string} 生成されたJWTトークン
 */
function generateJWT(username) {
    const nowTime = Math.round(new Date().getTime() / 1000);
    const aclPaths = {
        "/*/users/**": {},
        "/*/conversations/**": {},
        "/*/sessions/**": {},
        "/*/devices/**": {},
        "/*/image/**": {},
        "/*/media/**": {},
        "/*/applications/**": {},
        "/*/push/**": {},
        "/*/knocking/**": {},
        "/*/legs/**": {}
    };
    if (username) {
        return vcr.createVonageToken({ exp: nowTime + 86400, subject: username, aclPaths: aclPaths });
    } else {
        return vcr.createVonageToken({ exp: nowTime + 86400 });
    }
}

/**
 * 顧客のLeg IDを取得する
 * @param {string} conversation_uuid 
 * @param {string} operator_leg_id 
 * @returns {Promise<string>}
 */
async function getCustomerLegId(conversation_uuid, operator_leg_id) {
    try {
        console.log(`🐞 getCustomerLegId called. conversation_uuid: ${conversation_uuid}, operator_leg_id: ${operator_leg_id}`);
        // 会話に参加しているメンバー（Leg）を取得
        // getCalls は会話IDでのフィルタリングができないため、個別にLeg情報を管理していない場合は、
        // conversation_members などを参照する必要があるが、VCR SDKでどう行うか確認が必要。
        // ここでは、voice.listCalls() でフィルタリングできるか試みるが、SDKの仕様上厳しい場合がある。
        // そのため、簡易的に全コールから該当conversation_uuidを探すか、またはConversations APIを使うのが正しい。
        // ですが、今回は @vonage/server-sdk の voice オブジェクトを使っています。
        
        // server-sdk の voice.get_calls は全件取得になりがちなので注意が必要ですが、
        // filter object を渡せます。
        
        // NOTE: 実は client-sdk から serverCall したときや、PSTN着信時は leg_id が特定しやすいですが、
        // 相手側(customer)を特定するのは少しロジックがいります。
        // ここでは、"operator_leg_id ではない" かつ "status が started/ringing" であるものを探します。

        // 1. フィルターを使用して検索
        const filter = {
           conversationUuid: conversation_uuid
        };
        const page = await vonage.voice.search(filter);
        
        let calls = [];
        if (page && page._embedded && page._embedded.calls) {
            calls = page._embedded.calls;
        }

        // 2. 検索で見つからない場合のフォールバック: 全通話から手動フィルタリング
        if (calls.length === 0) {
            console.log(`🐞 Search by filter found 0. Trying manual filtering from all active calls...`);
            const allCallsPage = await vonage.voice.search({ status: 'started' });
            if (allCallsPage && allCallsPage._embedded && allCallsPage._embedded.calls) {
                calls = allCallsPage._embedded.calls.filter(c => c.conversationUuid === conversation_uuid || c.uuid === conversation_uuid);
            }
        }

        // 3. 検索で見つからない場合のフォールバック: ID自体がLeg IDである可能性をチェック
        if (calls.length === 0) {
            console.log(`🐞 Still 0 found. Checking if ${conversation_uuid} is a direct Leg ID...`);
            try {
                const directCall = await vonage.voice.getCall(conversation_uuid);
                if (directCall) {
                    console.log(`🐞 ${conversation_uuid} is a direct Leg ID.`);
                    // これが operator_leg_id でないなら、これが顧客の Leg ID
                    if (directCall.uuid !== operator_leg_id) return directCall.uuid;
                    
                    // これが operator_leg_id なら、同じ会話の別の Leg を探す
                    const convId = directCall.conversationUuid;
                    const convPage = await vonage.voice.search({ conversationUuid: convId });
                    if (convPage && convPage._embedded && convPage._embedded.calls) {
                        const other = convPage._embedded.calls.find(c => c.uuid !== operator_leg_id);
                        if (other) return other.uuid;
                    }
                }
            } catch (err) {
                console.log(`🐞 ${conversation_uuid} is not a valid Leg ID.`);
            }
        }

        console.log(`🐞 Total candidate calls found: ${calls.length}`);
        for (const call of calls) {
            if (call.uuid !== operator_leg_id) {
                console.log(`🐞 Customer leg detected: ${call.uuid}`);
                return call.uuid;
            }
        }
        return null;
    } catch (e) {
        console.error(e);
        return null;
    }
}

/**
 * 保留機能のエンドポイント
 */
app.post('/hold', async (req, res, next) => {
    console.log('🐞 /hold called', req.body);
    try {
        const { conversation_uuid, leg_id, action } = req.body;
        // 顧客のLeg IDを特定
        // クライアント側で自分のLeg IDがわかっていればそれを送ってもらう (leg_id)
        const customerLegId = await getCustomerLegId(conversation_uuid, leg_id);

        if (!customerLegId) {
            console.error(`🐞 Customer Not Found. conversation_uuid: ${conversation_uuid}, operator_leg_id: ${leg_id}`);
            res.status(404).send(`Customer Not Found for conversation ${conversation_uuid}`);
            return;
        }

        if (action === 'hold') {
            console.log(`🐞 Holding call: ${customerLegId}`);
            // 顧客側に保留音を再生
            // streamUrl は public フォルダの ringtone.mp3 を使う
            // VCR_INSTANCE_PUBLIC_URL が設定されている前提
            const streamUrl = `${process.env.VCR_INSTANCE_PUBLIC_URL}/hold_music.mp3`;
            await vonage.voice.streamAudio(customerLegId, streamUrl, 0); // 0 = loop infinitely
        } else if (action === 'unhold') {
            console.log(`🐞 Unholding call: ${customerLegId}`);
            // 音声再生を停止
            await vonage.voice.stopStreamAudio(customerLegId);
        }

        res.sendStatus(200);

    } catch (e) {
        next(e);
    }
});

/**
 * 転送機能のエンドポイント
 */
app.post('/transfer', async (req, res, next) => {
    console.log('🐞 /transfer called', req.body);
    try {
        const { conversation_uuid, leg_id, destination_number } = req.body;
        const customerLegId = await getCustomerLegId(conversation_uuid, leg_id);

        if (!customerLegId) {
             console.error('Customer Not Found');
             res.status(404).send('Customer Not Found');
             return;
        }
        
        console.log(`🐞 Transferring call: ${customerLegId} to ${destination_number}`);
        
        // 転送先のNCCOを作成
        const ncco = [
            {
                action: 'connect',
                from: process.env.VONAGE_NUMBER, // 発信元番号
                endpoint: [
                    {
                        type: 'phone',
                        number: destination_number.replace(/^0/, '81') // E.164形式へ簡易変換
                    }
                ]
            }
        ];

        // 転送実行
        await vonage.voice.transferCallWithNcco(customerLegId, ncco);
        
        // オペレーター側の通話を切断する必要があるかどうか？
        // transferCallWithNcco は指定したLeg (customer) を新しいNCCOに移動させる。
        // 元のConversationから引き剥がされるため、オペレーターは一人取り残される形になるはず。
        // クライアント側で hangup してもらうのが自然だが、サーバー側で切断も可能。
        // ここではサーバー側でオペレーターも切断する場合は以下を追加：
        // await vonage.voice.hangupCall(leg_id);
        
        res.sendStatus(200);

    } catch (e) {
        next(e);
    }
});

/**
 * WebSocketテスト用エンドポイント
 * @param {WebSocket} ws - WebSocketオブジェクト
 * @param {Object} req - リクエストオブジェクト
 */
router.ws('/test', (ws, req) => {
    ws.send('Connected');
    console.log(`🐞 ws connected`);
    // クライアントからのメッセージを受信したら、そのまま返す
    ws.on('message', (msg) => {
        console.log(`🐞 ws received: ${msg}`);
        ws.send(msg);
    });
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});