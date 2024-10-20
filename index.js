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
const END_POINT_RECORDING = process.env.END_POINT_RECORDING; // 録音データのエンドポイント
const END_POINT_TRANSCRIPTION = process.env.END_POINT_TRANSCRIPTION; // 音声認識データのエンドポイント

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

app.get('/_/health', async (req, res) => {
    res.sendStatus(200);
});

app.get('/_/metrics', async (req, res) => {
    res.sendStatus(200);
});

app.get('/getToken', async (req, res, next) => {
    try {
        let user;
        // オペレーター名の取得
        const name = req.query.name || 'Operator';
        try {
            // すでにユーザーが存在するかを確認
            const users = await vonage.users.getUserPage({name});
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

// キューイングデータの登録
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

// オペレーターのピックアップ
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

// オペレーターのステータス変更
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

// 着信のイベントハンドラ
app.post('/onCall', async (req, res, next) => {
    console.log(`🐞 onCall called via ${req.body.from ? req.body.from : req.body.from_user}`);
    console.dir(req.body);
    try {
        if (req.body.from) { // PSTN経由の着信
            // キューイングデータの登録
            putQueue(req.body, 'ENQUEUE');
            // オペレーターのピックアップ
            const userId = await pickupOperator();
            if (userId) { // オペレーターが見つかった場合
                // オペレーターのステータス変更
                updateOperatorStatus(req.body.conversation_uuid, req.body.from, '着信中', userId);
                res.json([
                    {
                        action: 'record',
                        eventUrl: [`${process.env.VCR_URL}/onEventRecorded`],
                        split: 'conversation',
                        transcription: {
                            language: 'ja-JP',
                            eventUrl: [`${process.env.VCR_URL}/onEventTranscribed`],
                            // sentimentAnalysis: true
                        },
                    },
                    {
                        action: 'connect',
                        eventUrl: [`${process.env.VCR_URL}/onEvent?userId=${userId}`],
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
                    eventUrl: [`${process.env.VCR_URL}/onEventRecorded`],
                    split: 'conversation',
                    transcription: {
                        language: 'ja-JP',
                        eventUrl: [`${process.env.VCR_URL}/onEventTranscribed`],
                        // sentimentAnalysis: true
                    },
                },
                {
                    action: 'connect',
                    eventUrl: [`${process.env.VCR_URL}/onEvent?userId=${userId}`],
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

// イベント発生時のイベントハンドラー
app.post('/onEvent', async (req, res, next) => {
    console.log(`🐞 onEvent called`);
    console.dir(req.body);
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

// 録音データをファイルに保存
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

// 録音終了時のイベントハンドラー
app.post('/onEventRecorded', async (req, res, next) => {
    console.log(`🐞 onEventRecorded called`);
    console.dir(req.body);
    try {
        // 録音データの保存
        await saveRecordFile(req.body.conversation_uuid, req.body.recording_url);
        const recordingUrl = `${process.env.VCR_URL}/tmp/${req.body.conversation_uuid}.mp3`;
        const data = {
            conversation_uuid: req.body.conversation_uuid,
            recording_url: recordingUrl,
            customer_id: ''
        }
        const response = await axios.post(END_POINT_RECORDING, data);
        console.log(`🐞 response data: ${JSON.stringify(response.data)}`)
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

// 音声認識データを取得
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

// 音声認識終了時のイベントハンドラー
app.post('/onEventTranscribed', async (req, res, next) => {
    console.log(`🐞 onEventTranscribed called`);
    console.dir(req.body);
    try {
        // 音声認識データの取得
        const transcript = await getTranscribedData(req.body.transcription_url);
        console.log(`🐞 transcript: ${transcript}`);
        const data = {
            conversation_uuid: req.body.conversation_uuid,
            transcript: transcript,
            customer_id: ''
        }
        const response = await axios.post(END_POINT_TRANSCRIPTION, data);
        console.log(`🐞 response data: ${JSON.stringify(response.data)}`)
        res.sendStatus(200);
    } catch (e) {
        next(e);
    }
});

// JWTの生成
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