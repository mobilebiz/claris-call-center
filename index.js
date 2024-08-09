import { Voice, vcr } from '@vonage/vcr-sdk';
import { Vonage } from '@vonage/server-sdk';
import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.VCR_PORT;
const vonage = new Vonage(
    {
      applicationId: process.env.API_APPLICATION_ID,
      privateKey: process.env.PRIVATE_KEY
    }
);

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

// 着信のイベントハンドラ
app.post('/onCall', async (req, res, next) => {
    console.log(`🐞 onCall called via ${req.body.from ? req.body.from : req.body.from_user}`);
    console.dir(req.body);
    try {
        if (req.body.from) { // PSTN経由の着信
            res.json([
                {
                    action: 'connect',
                    from: req.body.from,
                    endpoint: [{
                        type: 'app',
                        user: 'Operator' 
                    }]
                }
            ]);            
        } else {
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
    try {
        console.log('🐞 event status is: ', req.body.status);
        console.log('🐞 event direction is: ', req.body.direction);
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

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});