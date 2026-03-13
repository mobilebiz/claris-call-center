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
 * 会話内の Leg 一覧を特定し、オペレーターと顧客を判別して返す
 * @param {string} conversation_uuid 会話 UUID または Leg ID
 * @param {string} operator_leg_id_hint オペレーターの Leg ID (補助情報)
 * @param {string} operator_user_id オペレーターのユーザー名/ID
 * @returns {Promise<{operatorLegId: string, customerLegId: string}>}
 */
async function getCallLegs(conversation_uuid, operator_leg_id_hint, operator_user_id) {
    try {
        console.log(`🐞 getCallLegs called. conv_uuid_or_leg: ${conversation_uuid}, user: ${operator_user_id}, hint: ${operator_leg_id_hint}`);
        
        let targetConvId = conversation_uuid;
        let calls = [];
        let inputWasLegId = false;

        // 1. まず入力された ID が直接の Leg ID かどうか確認
        try {
            const complement = await vonage.voice.getCall(conversation_uuid);
            if (complement) {
                console.log(`🐞 input ${conversation_uuid} is a validated Leg ID. Conv: ${complement.conversationUUID}`);
                targetConvId = complement.conversationUUID;
                inputWasLegId = true;
            }
        } catch (e) {
            console.log(`🐞 input ${conversation_uuid} is not a direct Leg ID or lookup failed.`);
        }

        // 2. Conversation 内の全 Leg を検索
        const page = await vonage.voice.search({ conversationUuid: targetConvId });
        if (page && page._embedded && page._embedded.calls) {
            calls = page._embedded.calls;
        }

        console.log(`🐞 Found ${calls.length} legs for conv ${targetConvId}`);
        
        let operatorLegId = null;
        let customerLegId = null;

        // 3. オペレーターの Leg を特定する（優先順位: 入力ID自身 -> ヒント -> ユーザーIDマッチ）
        if (inputWasLegId) {
            operatorLegId = conversation_uuid;
        } else if (operator_leg_id_hint) {
            operatorLegId = operator_leg_id_hint;
        }

        for (const call of calls) {
            // 詳細ログ（全プロパティ確認用）
            console.log(`🐞 Analyzing leg ${call.uuid}: status=${call.status}, to=${JSON.stringify(call.to)}, from=${JSON.stringify(call.from)}`);
            
            if (operatorLegId) continue; // 既に特定済みならスキップ

            const getIdentifier = (endpoint) => {
                if (!endpoint) return '';
                return (endpoint.number || endpoint.user || endpoint.uri || '').toString();
            };

            const identifiers = getIdentifier(call.to) + getIdentifier(call.from);
            if (identifiers.includes(operator_user_id)) {
                operatorLegId = call.uuid;
                console.log(`🐞 Identified Operator Leg by UserID: ${operatorLegId}`);
            }
        }

        // 4. 顧客の Leg を特定する（オペレーターではない方）
        // ステータスについては、切断(completed)以外であれば対象とする
        for (const call of calls) {
            if (call.uuid !== operatorLegId && call.status !== 'completed') {
                customerLegId = call.uuid;
                console.log(`🐞 Identified Customer Leg: ${customerLegId}`);
                break;
            }
        }

        // 特殊ケース：2つしかなくて、片方がオペレーターなら、ステータスに関わらずもう片方が顧客
        if (calls.length === 2 && operatorLegId && !customerLegId) {
            const other = calls.find(c => c.uuid !== operatorLegId);
            if (other) {
                customerLegId = other.uuid;
                console.log(`🐞 Identified Customer Leg by elimination: ${customerLegId}`);
            }
        }

        // 5. ビジネス番号（転送時の発信元として使う番号）を抽出
        // 入力通話（PSTN -> App）なら顧客側の Leg の宛先番号 (to)
        // 出力通話（App -> PSTN）なら顧客側の Leg の発信元番号 (from)
        let businessNumber = process.env.VONAGE_NUMBER;
        const customerCall = calls.find(c => c.uuid === customerLegId);
        if (customerCall) {
            const toId = (customerCall.to && customerCall.to.type === 'phone') ? customerCall.to.number : '';
            const fromId = (customerCall.from && customerCall.from.type === 'phone') ? customerCall.from.number : '';
            
            // 顧客番号（通常は日本の携帯や固定電話）ではない方をビジネス番号とするための簡易推論
            // ここでは toId があればそれを優先し、なければ fromId を使う（インバウンドを優先）
            // もし両方 PSTN の場合は、toId が着信先番号なのでビジネス番号である可能性が高い
            businessNumber = toId || fromId || process.env.VONAGE_NUMBER;
            console.log(`🐞 Extracted Business Number candidates: to=${toId}, from=${fromId} -> Selected: ${businessNumber}`);
        }

        return { operatorLegId, customerLegId, businessNumber };
    } catch (e) {
        console.error(`🐞 Error in getCallLegs:`, e);
        return { operatorLegId: null, customerLegId: null, businessNumber: process.env.VONAGE_NUMBER };
    }
}

/**
 * 電話番号を E.164 形式 (+81...) に変換するヘルパー
 */
function formatToE164(number) {
    if (!number) return '';
    let clean = number.toString().replace(/[\s-]/g, '');
    if (clean.startsWith('0')) {
        clean = '81' + clean.slice(1);
    }
    if (clean.startsWith('81') && !clean.startsWith('+')) {
        clean = '+' + clean;
    }
    // その他のケース（既に+がついている、または海外番号など）はそのままとする
    return clean;
}

/**
 * 保留機能のエンドポイント
 */
app.post('/hold', async (req, res, next) => {
    console.log('🐞 /hold called', req.body);
    try {
        const { conversation_uuid, leg_id, action, operator_user_id } = req.body;
        // 会話内の全 Leg を取得し、オペレーターと顧客を特定
        const { operatorLegId, customerLegId } = await getCallLegs(conversation_uuid, leg_id, operator_user_id);

        if (!customerLegId) {
            console.error(`🐞 Customer Not Found. conv: ${conversation_uuid}, operator_user: ${operator_user_id}, hint: ${leg_id}`);
            res.status(404).send(`Customer Not Found for conversation ${conversation_uuid}`);
            return;
        }

        // オペレーター ID を特定したもので更新
        const finalOperatorId = operatorLegId || leg_id;

        if (action === 'hold') {
            console.log(`🐞 Holding calls: operator=${finalOperatorId}, customer=${customerLegId}`);
            
            const streamUrl = `${process.env.VCR_INSTANCE_PUBLIC_URL}/hold_music.mp3`;
            console.log(`🐞 Streaming audio to: ${streamUrl}`);
            
            const streams = [];
            if (finalOperatorId) {
                console.log(`🐞 Starting stream to operator: ${finalOperatorId}`);
                streams.push(vonage.voice.streamAudio(finalOperatorId, streamUrl, 0));
            }
            if (customerLegId) {
                console.log(`🐞 Starting stream to customer: ${customerLegId}`);
                streams.push(vonage.voice.streamAudio(customerLegId, streamUrl, 0));
            }

            try {
                await Promise.allSettled(streams);
                console.log(`🐞 Audio stream requests processed.`);
            } catch (err) {
                console.error(`🐞 Critical error during streamAudio:`, err.message);
            }
        } else if (action === 'unhold') {
            console.log(`🐞 Unholding calls: operator=${finalOperatorId}, customer=${customerLegId}`);
            
            const stops = [];
            if (finalOperatorId) stops.push(vonage.voice.stopStreamAudio(finalOperatorId).catch(e => console.log(`🐞 Stop operator stream failed: ${e.message}`)));
            if (customerLegId) stops.push(vonage.voice.stopStreamAudio(customerLegId).catch(e => console.log(`🐞 Stop customer stream failed: ${e.message}`)));
            
            await Promise.allSettled(stops);
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
        const { conversation_uuid, leg_id, destination_number, operator_user_id } = req.body;
        // 会話内の全 Leg を取得し、オペレーター、顧客、およびビジネス番号を特定
        const { customerLegId, businessNumber } = await getCallLegs(conversation_uuid, leg_id, operator_user_id);

        if (!customerLegId) {
             console.error('Customer Not Found');
             res.status(404).send('Customer Not Found');
             return;
        }
        
        const finalDest = formatToE164(destination_number);
        const finalFrom = formatToE164(businessNumber) || process.env.VONAGE_NUMBER;

        console.log(`🐞 Transferring call: ${customerLegId} to ${finalDest} (from: ${finalFrom})`);
        
        // 転送先のNCCOを作成
        const ncco = [
            {
                action: 'talk',
                text: '担当者にお繋ぎします。しばらくお待ちください。',
                language: 'ja-JP',
                style: 0
            },
            {
                action: 'connect',
                from: finalFrom,
                eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEvent?userId=${operator_user_id}`],
                endpoint: [
                    {
                        type: 'phone',
                        number: finalDest
                    }
                ]
            }
        ];

        console.log(`🐞 Sending Transfer NCCO:`, JSON.stringify(ncco, null, 2));

        // 転送実行
        await vonage.voice.transferCallWithNCCO(customerLegId, ncco);
        
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