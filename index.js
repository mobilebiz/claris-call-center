import { Voice, vcr } from '@vonage/vcr-sdk';
import { Vonage } from '@vonage/server-sdk';
import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import axios from 'axios';

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
const putQueue = async (body) => {
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic dm9uYWdlOnZvbmFnZQ==`
        }
        const data = {
            Conversation_uuid: body.conversation_uuid,
            Status: 'ENQUEUE'
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
            'Authorization': `Basic dm9uYWdlOnZvbmFnZQ==`
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
            'Authorization': `Basic dm9uYWdlOnZvbmFnZQ==`
        }
        const data = {
            Status: status,
            IncomingNumber: incomingNumber,
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
    // {
    //   region_url: 'https://api-ap-3.vonage.com',
    //   from: '818040643515',
    //   to: '815031023328',
    //   uuid: 'ca0e0bb06727997fea1f2a0d820daf86',
    //   conversation_uuid: 'CON-2cb7723e-9bd5-4275-8064-254eda87a94b'
    // }
    try {
        if (req.body.from) { // PSTN経由の着信
            // キューイングデータの登録
            putQueue(req.body);
            // オペレーターのピックアップ
            const userId = await pickupOperator();
            if (userId) { // オペレーターが見つかった場合
                // オペレーターのステータス変更
                updateOperatorStatus(req.body.conversation_uuid, req.body.from.replace(/^\+81/, '0'), '着信中', userId);
                res.json([
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
            res.json([
                {
                    action: 'connect',
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
            // オペレーターのステータス変更
            await updateOperatorStatus(req.body.conversation_uuid, req.body.from.replace(/^\+81/, '0'), '通話中', req.query.userId);
        }
        // 通話終了時の処理
        if (req.body.status === 'completed') {
            // オペレーターのステータス変更
            await updateOperatorStatus(req.body.conversation_uuid, '', '待受中', req.query.userId);
        }
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