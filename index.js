import { Voice, vcr } from '@vonage/vcr-sdk';
import { Vonage } from '@vonage/server-sdk';
import express from 'express';
import expressWs from 'express-ws';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';
import util from 'util';

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

// --- Vonage 連携初期化 ---
const session = vcr.createSession();
const voice = new Voice(session);

// --- 相談転送（Warm Transfer）の状態管理 ---
// VCR はステートレス構成（複数レプリカ / 再起動 / スケール to ゼロ）のため、
// プロセスメモリではなく全レプリカで共有される Instance State に保存する。
//   consult:session:<confName>  … セッション本体。Redis ハッシュとして持つ
//                                 { customerLegId, operatorLegId, transferLegId, operatorUserId, isConsulting }
//   consult:leg:<legId>         … レグ ID → confName の逆引き（onEvent がレグ ID から引くため）
//   consult:operator:<userId>   … オペレーター ID → confName の逆引き（cancelTransfer 用）
//   consult:conversation:<uuid> … 通話 → 現在の confName（転送やり直し時に前回分を破棄するため）
//
// confName は転送試行ごとに一意（/transfer で生成）。同じ通話で転送をやり直しても
// キーが衝突しないため、前回の試行のレグや遅延イベントが現在のセッションに混入しない。
//
// セッション本体をハッシュにしているのは、レグのクリアを「フィールド単位の削除 (HDEL)」で
// 原子的に行うため。JSON 一括の read-modify-write だと、複数レグがほぼ同時に completed に
// なった際に後勝ちで他レプリカの更新を巻き戻し、消したはずのレグが復活してしまう。
const state = vcr.getInstanceState();
// 通話中はステート更新が走らないため、TTL は「機能上の打ち切り」ではなく
// 取りこぼしたセッションを回収するための保険として、想定通話時間より十分長く取る。
// 24 時間を超える通話は業務上発生しないため、ハートビートによる TTL 更新は導入しない
// （定期処理という故障点を増やす方がリスクが大きいという判断）。
const CONSULT_TTL_SECONDS = 24 * 60 * 60;
const CONSULT_LEG_FIELDS = ['customerLegId', 'operatorLegId', 'transferLegId'];

const consultSessionKey = (confName) => `consult:session:${confName}`;
const consultLegKey = (legId) => `consult:leg:${legId}`;
const consultOperatorKey = (userId) => `consult:operator:${userId}`;
const consultConversationKey = (conversationUuid) => `consult:conversation:${conversationUuid}`;
const consultLegIds = (c) => CONSULT_LEG_FIELDS.map((field) => c?.[field]).filter(Boolean);

/**
 * レグ ID の逆引きインデックスを張る
 * @param {string} legId - レグ ID
 * @param {string} confName - 会議名
 */
const setConsultationLegIndex = async (legId, confName) => {
    await state.set(consultLegKey(legId), confName);
    await state.expire(consultLegKey(legId), CONSULT_TTL_SECONDS);
};

/**
 * 相談転送セッションを新規に作成し、逆引きインデックスを張る
 * @param {string} confName - 会議名（セッションのキー）。転送試行ごとに一意
 * @param {Object} consultation - 作成するセッション
 * @param {string} conversationUuid - 通話 ID。前回の試行を破棄するために使う
 */
const createConsultationSession = async (confName, consultation, conversationUuid) => {
    // 同じ通話で転送をやり直すと、前回の試行のセッションが残る。confName が一意なので
    // 単純な上書きでは消えず、古い転送レグの遅延 completed がその古いセッションに当たると
    // 既に誰もいない会議室へお客様を引き込んでしまう。会話単位の索引から辿って破棄する。
    const previousConfName = conversationUuid
        ? await state.get(consultConversationKey(conversationUuid))
        : null;
    if (previousConfName) {
        const previous = await getConsultationSession(previousConfName);
        if (previous) {
            console.log(`🐞 Discarding previous consultation session ${previousConfName}`);
            await deleteConsultationSession(previousConfName, previous);
        }
    }

    const fields = {};
    for (const [key, value] of Object.entries(consultation)) {
        // ハッシュの値は文字列のみ。未確定のレグはフィールドごと持たせない
        if (value !== null && value !== undefined) fields[key] = String(value);
    }
    // mapSet は HSET なので既存フィールドにマージされる。同じキーに残骸があった場合に
    // 古いレグ（特に transferLegId）を持ち越さないよう、書く前に必ず消しておく。
    await state.delete(consultSessionKey(confName));
    await state.mapSet(consultSessionKey(confName), fields);
    await state.expire(consultSessionKey(confName), CONSULT_TTL_SECONDS);

    await Promise.all(consultLegIds(consultation).map((legId) => setConsultationLegIndex(legId, confName)));

    if (consultation.operatorUserId) {
        await state.set(consultOperatorKey(consultation.operatorUserId), confName);
        await state.expire(consultOperatorKey(consultation.operatorUserId), CONSULT_TTL_SECONDS);
    }

    if (conversationUuid) {
        await state.set(consultConversationKey(conversationUuid), confName);
        await state.expire(consultConversationKey(conversationUuid), CONSULT_TTL_SECONDS);
    }
};

/**
 * 会議名から相談転送セッションを取得する
 * @param {string} confName - 会議名
 * @returns {Promise<Object|null>} セッション。存在しなければ null
 */
const getConsultationSession = async (confName) => {
    if (!confName) return null;
    const fields = await state.mapGetAll(consultSessionKey(confName));
    return fields && Object.keys(fields).length > 0 ? fields : null;
};

/**
 * セッションにレグ ID を設定し、逆引きインデックスも張る
 * 他のフィールドには触れないため、並行する更新を巻き戻さない
 * @param {string} confName - 会議名
 * @param {string} field - 設定するフィールド名（CONSULT_LEG_FIELDS のいずれか）
 * @param {string} legId - レグ ID
 */
const setConsultationLeg = async (confName, field, legId) => {
    await state.mapSet(consultSessionKey(confName), { [field]: legId });
    await state.expire(consultSessionKey(confName), CONSULT_TTL_SECONDS);
    await setConsultationLegIndex(legId, confName);
};

/**
 * セッションからレグ ID を取り除き、逆引きインデックスも削除する
 * HDEL による単一フィールド削除なので、他レプリカの更新と競合しない
 * @param {string} confName - 会議名
 * @param {string} field - クリアするフィールド名（CONSULT_LEG_FIELDS のいずれか）
 * @param {string} legId - クリアするレグ ID
 * @returns {Promise<boolean>} 実際にクリアしたら true、既に差し替わっていたら false
 */
const clearConsultationLeg = async (confName, field, legId) => {
    // 読み取り後にレグが差し替わっている（転送リトライ等）場合、新しいレグの登録を
    // 消さないよう現在値を確認してから削除する。State API に CAS がないため完全な
    // 原子性はないが、競合の窓を 1 往復ぶんに狭められる。
    const currentLegId = await state.mapGetValue(consultSessionKey(confName), field);
    if (currentLegId && currentLegId !== legId) {
        console.log(`🐞 Skip clearing ${field}: already replaced by ${currentLegId} (was ${legId})`);
        await state.delete(consultLegKey(legId));
        return false;
    }
    await state.mapDelete(consultSessionKey(confName), [field]);
    await state.delete(consultLegKey(legId));
    return true;
};

/**
 * 逆引きインデックス経由で相談転送セッションを引く
 * @param {string} indexKey - 逆引きインデックスのキー
 * @returns {Promise<{confName: string|null, consultation: Object|null}>}
 */
const findConsultationByIndex = async (indexKey) => {
    const confName = await state.get(indexKey);
    if (!confName) return { confName: null, consultation: null };
    const consultation = await getConsultationSession(confName);
    // 逆引きだけ残ってセッション本体が消えている場合は未検出として扱う
    return consultation ? { confName, consultation } : { confName: null, consultation: null };
};

/**
 * レグ ID から相談転送セッションを引く
 * @param {string} legId - レグ ID
 * @returns {Promise<{confName: string|null, consultation: Object|null}>}
 */
const findConsultationByLeg = async (legId) => {
    if (!legId) return { confName: null, consultation: null };
    return await findConsultationByIndex(consultLegKey(legId));
};

/**
 * オペレーターのユーザー ID から相談転送セッションを引く
 * @param {string} userId - オペレーターのユーザー ID
 * @returns {Promise<{confName: string|null, consultation: Object|null}>}
 */
const findConsultationByOperator = async (userId) => {
    if (!userId) return { confName: null, consultation: null };
    return await findConsultationByIndex(consultOperatorKey(userId));
};

/**
 * 相談転送セッションと逆引きインデックスをまとめて削除する
 * @param {string} confName - 会議名
 * @param {Object} consultation - 削除対象のセッション（逆引きを消すために使う）
 */
const deleteConsultationSession = async (confName, consultation) => {
    await state.delete(consultSessionKey(confName));
    await Promise.all(consultLegIds(consultation).map((legId) => state.delete(consultLegKey(legId))));

    // オペレーターの逆引きは意図的に消さない。
    // オペレーター ID は通話をまたいで再利用されるため、同じオペレーターが次の相談転送を
    // 始めていると索引は既に新しい会議を指している。ここで消すと新しい方の
    // /cancelTransfer が 404 になる。「読み取り → 比較 → 削除」にしても 2 往復ある以上
    // その競合は残るので、削除自体をやめるのが確実。
    // 取り残された索引は findConsultationByIndex がセッション本体の不在を見て未検出として
    // 扱い、TTL で自然に消える。
    // レグ ID は通話ごとに一意で再利用されないため、こちらは上で削除して問題ない
    // （重複 webhook に対する冪等性の担保にもなる）。
};

// セッション内で着信があった場合に呼び出す関数を定義
await voice.onCall('onCall');
// セッション内のイベントが発生した場合の関数を定義
await voice.onCallEvent({ callback: 'onEvent' });

/**
 * サービス状態確認 (ヘルスチェック)
 */
app.get('/_/health', (req, res) => res.sendStatus(200));
app.get('/_/metrics', (req, res) => res.sendStatus(200));

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
 * 待受中のオペレーターから LastCallTime 昇順で 1 名を選定する。
 * 並行して、診断目的で全オペレーターの状態スナップショットをログに残す（失敗しても選定処理に影響させない）。
 * @returns {Promise<string>} オペレーターのユーザーID
 */
const pickupOperator = async () => {
    console.log('🐞 pickupOperator called');
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }

        // 1) 選定本処理: 従来通り絞り込み済みクエリ。100 件上限の影響を受けず、確実に先頭の待受中を返す。
        const selectResp = await axios.get(
            `${CLARIS_SERVER}/Operator_Status?$top=1&$select=UserID&$filter=Status eq '待受中'&$orderby=LastCallTime asc`,
            { headers }
        );
        const picked = selectResp.data?.value?.[0]?.UserID || '';

        // 2) 診断ログ: 全件スナップショット。Issue 2 切り分け用なので失敗しても選定は止めない。
        try {
            const snapResp = await axios.get(
                `${CLARIS_SERVER}/Operator_Status?$top=100&$select=UserID,Status,LastCallTime,IncomingNumber,Conversation_uuid&$orderby=LastCallTime asc`,
                { headers }
            );
            const all = snapResp.data?.value || [];
            console.log(`🐞 [pickupOperator] snapshot (count=${all.length}):`);
            for (const op of all) {
                if (!op) continue;
                console.log(`   - ${op.UserID} | status=${op.Status} | lastCall=${op.LastCallTime || '-'} | incoming=${op.IncomingNumber || '-'} | convId=${op.Conversation_uuid || '-'}`);
            }
            const candidates = all.filter(op => op && op.Status === '待受中');
            console.log(`🐞 [pickupOperator] candidates(待受中)=${candidates.length}: [${candidates.map(o => o.UserID).join(', ')}]`);
        } catch (logErr) {
            console.error(`🐞 [pickupOperator] diagnostic snapshot failed:`, logErr.message);
        }

        console.log(`🐞 [pickupOperator] selected: ${picked || '(none → announcement)'}`);
        return picked;
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
            IncomingNumber: status === '待受中' ? '' : incomingNumber.replace(/^\+?81/, '0'),
            Conversation_uuid: status === '待受中' ? '' : conversationId
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
                        eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEventTranscribed`]
                    }
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
 */
app.post('/onEvent', async (req, res, next) => {
    console.log(`🐞 onEvent called: status=${req.body.status}, uuid=${req.body.uuid}, conv=${req.body.conversation_uuid}`);
    try {
        const { status, direction, uuid, conversation_uuid } = req.body;
        const { userId, isTransferLeg, confName } = req.query;

        console.log('🐞 meta:', { userId, isTransferLeg, confName });

        // 相談転送（Warm Transfer）の処理
        // 会話IDは変動するため、自身のレグIDから逆引きインデックス経由でセッションを特定する
        let { confName: targetConfId, consultation } = await findConsultationByLeg(uuid);

        // 転送レグはハッシュへの書き込みと逆引きの登録の間に切断されると索引から引けない。
        // その場合は eventUrl に載っている confName から直接引く。
        //
        // confName は転送試行ごとに一意なので、前回の試行のイベントがここに混入することは
        // 本来ない（前回分は createConsultationSession が破棄済み）。それでも多重防御として、
        // 自分のレグが実際に登録されているセッションだけを受け入れる。
        if (!consultation && confName) {
            const fallback = await getConsultationSession(confName);
            if (fallback && consultLegIds(fallback).includes(uuid)) {
                targetConfId = confName;
                consultation = fallback;
                console.log(`🐞 Consultation resolved via confName fallback: ${confName}`);
            }
        }

        // Fallback: userId がクエリにない場合、セッションから復元
        const activeUserId = userId || (consultation ? consultation.operatorUserId : null);

        if (consultation && status === 'completed') {
            console.log(`🐞 Consultation session event: uuid=${uuid}, session:`, consultation);

            // 自分のレグだけをフィールド単位で消す。複数レグが同時に completed になっても
            // 他レプリカの更新を巻き戻さない
            const clearedField = CONSULT_LEG_FIELDS.find((field) => consultation[field] === uuid);
            // 自分のレグが既に別のレグへ置き換わっていた場合、このイベントは現在の
            // セッションの状態を表していない。残レグ判定に進むと、生きているセッションを
            // 誤って破棄したりお客様を会議に引き込んだりするため、ここで打ち切る。
            const cleared = clearedField
                ? await clearConsultationLeg(targetConfId, clearedField, uuid)
                : false;

            if (!cleared) {
                console.log(`🐞 Leg ${uuid} is not part of the current session state. Skipping session cleanup.`);
            }

            // クリア後の最新状態を読み直す（他レプリカの更新も反映された状態で判断する）
            const current = cleared ? await getConsultationSession(targetConfId) : null;
            const remainingLegs = consultLegIds(current);
            console.log(`🐞 Remaining legs in session count: ${remainingLegs.length}`, remainingLegs);

            if (!current) {
                // クリアできなかった（レグが置き換わっていた）か、他レプリカが
                // 既にクリーンアップ済み。どちらの場合も状態判断はしない
            } else if (remainingLegs.length === 2) {
                // 3人から2人になった場合（例：相談開始後にどちらかが切れた、または3人会議からの離脱）
                // お客様が残っている場合のみ、お客様の保留解除（橋渡し）を行う
                if (current.customerLegId) {
                    const remainingMemberLegId = remainingLegs.find(id => id !== current.customerLegId);
                    console.log(`🐞 STAFF disconnected. Bridging customer ${current.customerLegId} to ${remainingMemberLegId}`);
                    
                    const resumeNcco = [{ 
                        action: 'conversation', 
                        name: `${targetConfId}`,
                        startConferenceOnEnter: true
                    }];
                    try {
                        await vonage.voice.transferCallWithNCCO(current.customerLegId, resumeNcco);
                        console.log(`✅ Customer bridging initiated.`);
                    } catch (err) {
                        console.error(`❌ Failed to bridge customer:`, err.message);
                        // 転送失敗時はクリーンアップ
                        await deleteConsultationSession(targetConfId, current);
                    }
                }
            } else if (remainingLegs.length === 1) {
                // 残り1人になった場合 -> 全員終了（連鎖切断）
                const lastLegId = remainingLegs[0];
                console.log(`🐞 Only 1 leg remains (${lastLegId}). Terminating session...`);
                try {
                    await vonage.voice.hangupCall(lastLegId);
                } catch (err) {
                    console.error(`❌ Failed to hangup last leg:`, err.message);
                }
                await deleteConsultationSession(targetConfId, current);
            } else if (remainingLegs.length === 0) {
                // 全員終了
                console.log(`🐞 No legs remain. Cleaning up session.`);
                await deleteConsultationSession(targetConfId, current);
            } else {
                // 3 レグ以上。並行して新しいレグが登録された等の想定外の状態なので、
                // 生きているセッションを壊さないよう何もしない
                console.warn(`⚠️ Unexpected leg count ${remainingLegs.length} for ${targetConfId}. Leaving session intact.`);
            }
        }

        // 転送先レグ (B-leg or Outbound leg) が応答した際の UUID 記録
        if (isTransferLeg === 'true' && status === 'answered') {
            const pendingConsultation = await getConsultationSession(confName);
            if (pendingConsultation) {
                await setConsultationLeg(confName, 'transferLegId', uuid);
                console.log(`🐞 Captured transferLegId for ${confName}: ${uuid}`);
            }
        }

        // --- オペレーターのステータス管理 (CRM連携) ---
        if (activeUserId) {
            // CRM連携には本来の会話UUID(conversation_uuid)を一貫して使用する
            const crmConvId = conversation_uuid;
            
            if (status === 'ringing') {
                console.log(`🐞 updateOperatorStatus to Ringing for ${activeUserId}`);
                await updateOperatorStatus(crmConvId, req.body.from || '', '着信中', activeUserId);
                // ログデータの開始記録 (App間転送などのため)
                await putQueue({ conversation_uuid: crmConvId, from: req.body.from, to: req.body.to }, 'CALLING');
            } else if (status === 'answered' && direction === 'outbound') {
                console.log(`🐞 updateOperatorStatus to In-Call for ${activeUserId}`);
                await updateOperatorStatus(crmConvId, req.body.from || '', '通話中', activeUserId);
            } else if (status === 'completed') {
                console.log(`🐞 updateOperatorStatus to Available for ${activeUserId}`);
                await updateOperatorStatus(crmConvId, '', '待受中', activeUserId);
                // ログデータの完了記録
                await putQueue({ conversation_uuid: crmConvId, from: req.body.from, to: req.body.to }, 'COMPLETED');
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error('🐞 onEvent Error:', e.message);
        next(e);
    }
});

/**
 * 録音データをファイルに保存
 * @param {string} conversation_uuid - 会話UUID
 * @param {string} recording_url - 録音データのURL
 * @returns {Promise<void>}
 */
// --- 録音ファイルの中継 ---
// VCR はステートレス構成のため、レプリカローカルのディスクに保存できない
// （保存したレプリカ以外に取得リクエストが来ると 404 になる / 再起動で消える）。
// そのため保存はせず、取得要求が来た時点で Vonage からストリームで中継する。
// Vonage の recording_url は conversation_uuid から導出できないので、
// webhook で受け取った URL と署名用トークンだけを State に持つ。
//
// トークンは初回取得で消費する「ワンタイム」ではなく、期限付きの bearer トークン。
// FM の Insert from URL が失敗してリトライする運用があった場合に取得不能になるのを
// 避けるため、消費はしない。代わりに TTL を短くして再利用できる窓を絞る。
// FM は webhook 直後（通常は数秒以内）に取りに来るため、1 時間あれば十分。
const RECORDING_TTL_SECONDS = 60 * 60;
const recordingKey = (conversationUuid) => `recording:${conversationUuid}`;

/**
 * 録音終了時のイベントハンドラー
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @param {Function} next - 次のミドルウェア関数
 */
app.post('/onEventRecorded', async (req, res, next) => {
    console.log(`🐞 onEventRecorded called`);
    try {
        const conversationUuid = req.body.conversation_uuid;

        // 取得エンドポイントを保護するためのトークン（有効期限は RECORDING_TTL_SECONDS）。
        // FM 側は URL にクエリが付くだけで、Insert from URL の書き方は変わらない。
        const token = crypto.randomBytes(32).toString('hex');
        await state.mapSet(recordingKey(conversationUuid), {
            recordingUrl: req.body.recording_url,
            token
        });
        await state.expire(recordingKey(conversationUuid), RECORDING_TTL_SECONDS);

        const recordingUrl = `${process.env.VCR_INSTANCE_PUBLIC_URL}/recording/${conversationUuid}.mp3?token=${token}`;
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
 * 録音ファイルの取得（Vonage からのストリーム中継）
 * ディスクに保存せずそのまま流すため、どのレプリカが受けても同じ結果になる。
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 */
app.get('/recording/:conversationUuid.mp3', async (req, res) => {
    const { conversationUuid } = req.params;
    console.log(`🐞 /recording called for ${conversationUuid}`);
    try {
        const entry = await state.mapGetAll(recordingKey(conversationUuid));
        if (!entry || !entry.token || !entry.recordingUrl) {
            console.warn(`⚠️ Recording entry not found: ${conversationUuid}`);
            res.sendStatus(404);
            return;
        }

        // トークンはタイミング攻撃を避けるため定数時間で比較する
        const expected = Buffer.from(entry.token);
        const provided = Buffer.from(String(req.query.token || ''));
        if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
            console.warn(`⚠️ Recording token mismatch: ${conversationUuid}`);
            res.sendStatus(403);
            return;
        }

        // Vonage の録音取得には JWT が必要
        const upstream = await axios.get(entry.recordingUrl, {
            headers: { Authorization: `Bearer ${generateJWT()}` },
            responseType: 'stream'
        });

        res.setHeader('Content-Type', 'audio/mpeg');
        if (upstream.headers['content-length']) {
            res.setHeader('Content-Length', upstream.headers['content-length']);
        }

        // 全量をバッファせずそのまま流す。FM 側の待ち時間は Vonage の TTFB 程度に収まる
        upstream.data.on('error', (err) => {
            console.error(`❌ Recording stream error (${conversationUuid}):`, err.message);
            res.destroy();
        });
        res.on('close', () => upstream.data.destroy());
        upstream.data.pipe(res);
    } catch (e) {
        console.error(`❌ Failed to relay recording ${conversationUuid}:`, e.message);
        if (!res.headersSent) res.sendStatus(502);
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
                console.log(`🐞 Starting API stream to operator: ${finalOperatorId}`);
                streams.push(vonage.voice.streamAudio(finalOperatorId, streamUrl, 0));
            }
            if (customerLegId) {
                console.log(`🐞 Starting API stream to customer: ${customerLegId}`);
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
            if (finalOperatorId) {
                stops.push(
                    vonage.voice.stopStreamAudio(finalOperatorId)
                        .then(() => console.log(`✅ Stopped operator stream: ${finalOperatorId}`))
                        .catch(e => console.log(`🐞 Stop operator stream failed: ${e.message}`))
                );
            }
            if (customerLegId) {
                stops.push(
                    vonage.voice.stopStreamAudio(customerLegId)
                        .then(() => console.log(`✅ Stopped customer stream: ${customerLegId}`))
                        .catch(e => console.log(`🐞 Stop customer stream failed: ${e.message}`))
                );
            }
            
            await Promise.allSettled(stops);
        }

        res.sendStatus(200);

    } catch (e) {
        next(e);
    }
});

/**
 * 転送機能のエンドポイント（相談転送 / Warm Transfer）
 */
app.post('/transfer', async (req, res, next) => {
    console.log('🐞 /transfer called (Consultative)', req.body);
    try {
        const { conversation_uuid, leg_id, destination_number, operator_user_id } = req.body;
        // 会話内の全 Leg を取得
        const { operatorLegId, customerLegId, businessNumber } = await getCallLegs(conversation_uuid, leg_id, operator_user_id);

        if (!customerLegId || !operatorLegId) {
             console.error('Required Legs Not Found for transfer');
             res.status(404).send('Customer or Operator Leg Not Found');
             return;
        }


        
        // 宛先タイプの自動判別 (数字・記号のみなら phone, それ以外 [アルファベット等] は app)
        const isPhone = /^[0-9+.\-\s]+$/.test(destination_number);
        const destType = isPhone ? 'phone' : 'app';
        console.log(`🐞 Transfer Destination Type: ${destType} for "${destination_number}"`);

        const finalDest = isPhone ? formatToE164(destination_number) : destination_number;
        const finalFrom = formatToE164(businessNumber) || process.env.VONAGE_NUMBER;

        // 会議名は Conversation ID の末尾 + 転送試行ごとのランダム接尾辞。
        // 同じ通話で転送をやり直しても前回と別の会議・別のセッションキーになるため、
        // 前回の試行のレグや遅延イベントが現在のセッションに混入しない。
        // 長さは "C-" + 12 + "-" + 6 = 21 文字で、会議名の 40 文字制限に収まる。
        const confId = conversation_uuid.split('-').pop() || 'room';
        const confName = `C-${confId}-${crypto.randomBytes(3).toString('hex')}`; 
        
        console.log(`🐞 Starting Consultative Transfer: conv=${confName}, customer=${customerLegId}, operator=${operatorLegId}, type=${destType}`);

        // 状態の記録（全レプリカで共有される Instance State へ）
        const consultation = {
            customerLegId,
            operatorLegId,
            operatorUserId: operator_user_id, // 後のイベントでの復元用
            transferLegId: null, // 発信後に確定させる
            isConsulting: true
        };
        await createConsultationSession(confName, consultation, conversation_uuid);

        // 1. まず現在の保留音を止める（念のため）
        await Promise.allSettled([
            vonage.voice.stopStreamAudio(operatorLegId).catch(() => {}),
            vonage.voice.stopStreamAudio(customerLegId).catch(() => {})
        ]);

        // 2. お客様を一旦保留用 NCCO へ移動（会議には参加させない）
        // オペレーターが転送先と相談している間、お客様はこの保留 NCCO で音楽を聴き続ける。
        const customerNcco = [
            {
                action: 'talk',
                text: '担当者にお繋ぎします。そのままお待ちください。',
                language: 'ja-JP'
            },
            {
                action: 'stream',
                streamUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/hold_music.mp3`],
                loop: 0
            }
        ];
        await vonage.voice.transferCallWithNCCO(customerLegId, customerNcco);

        // 3. オペレーターを会議室へ移動
        const operatorNcco = [
            {
                action: 'talk',
                text: '転送先を呼び出しています。そのままお待ちください。',
                language: 'ja-JP'
            },
            {
                action: 'conversation',
                name: `${confName}`,
                startConferenceOnEnter: true,
                endConferenceOnExit: false
            }
        ];
        await vonage.voice.transferCallWithNCCO(operatorLegId, operatorNcco);

        // 4. 転送先へ発信（応答時に会議室へ参加させる）
        const inviteNcco = [
            {
                action: 'talk',
                text: '転送電話です。少々お待ちください。',
                language: 'ja-JP'
            },
            {
                action: 'conversation',
                name: `${confName}`,
                startConferenceOnEnter: true,
                endConferenceOnExit: true // 転送先が切れたら会議を終了（オペレーター復帰ロジックに繋げる）
            }
        ];

        if (destType === 'app') {
            // App 宛の場合は createOutboundCall が "Type APP is not supported" で失敗するため、
            // オペレーター自身を connect NCCO で転送先に繋ぐワークアラウンドを使用する。
            console.log(`🐞 [Workaround] Calling App user via NCCO Connect: ${operatorLegId} -> ${finalDest}`);
            const operatorConnectNcco = [
                {
                    action: 'talk',
                    text: '転送先を呼び出しています。そのままお待ちください。',
                    language: 'ja-JP'
                },
                {
                    action: 'connect',
                    from: finalFrom.replace(/^\+/, ''),
                    endpoint: [{ type: 'app', user: finalDest }],
                    // 宛先レグ (B-leg) の状態を管理するために、userId は転送先 (finalDest) を指定する
                    eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEvent?userId=${encodeURIComponent(finalDest)}&isTransferLeg=true&confName=${encodeURIComponent(confName)}`]
                },
                // 接続が終了した（宛先が切った）場合、あるいは失敗した場合、オペレーターを再度会議室（お客様待機場所）へ移動させる準備
                {
                    action: 'conversation',
                    name: `${confName}`,
                    startConferenceOnEnter: true
                }
            ];

            try {
                await vonage.voice.transferCallWithNCCO(operatorLegId, operatorConnectNcco);
                res.sendStatus(200);
            } catch (err) {
                console.error(`🐞 App transfer connect workaround failed:`, err.message);
                res.status(500).send('Failed to initiate app connection');
            }
            return;
        }

        // --- 外線（PSTN）宛ての場合は従来通り createOutboundCall を使用 ---
        try {
            const endpoint = { type: 'phone', number: finalDest };
            const fromObject = { type: 'phone', number: finalFrom.replace(/^\+/, '') };
            
            console.log(`🐞 Outbound Call Request (PSTN):`, {
                to: [endpoint],
                from: fromObject,
                confName
            });

            const result = await vonage.voice.createOutboundCall({
                to: [endpoint],
                from: fromObject,
                ncco: inviteNcco,
                eventUrl: [`${process.env.VCR_INSTANCE_PUBLIC_URL}/onEvent?isTransferLeg=true&confName=${encodeURIComponent(confName)}`]
            });
            console.log(`🐞 Outbound call to ${finalDest} initiated: uuid=${result.uuid}`);
            await setConsultationLeg(confName, 'transferLegId', result.uuid);
        } catch (err) {
            console.error(`🐞 --- OUTBOUND CALL FAILED (PSTN) ---`);
            console.error(`🐞 Error Message:`, err.message);
            
            if (err.response) {
                console.error(`🐞 [Response Found] status:`, err.response.status);
                if (typeof err.response.text === 'function') {
                    try {
                        const bodyText = await err.response.text();
                        console.error(`🐞 [Response Body Text]:`, bodyText);
                    } catch (e) {}
                } else {
                    console.error(`🐞 [Response Data]:`, util.inspect(err.response.data, { depth: null, colors: false }));
                }
            }
            res.status(500).send('Failed to dial destination');
            return;
        }

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

/**
 * 転送キャンセル（転送先のみ切断し、お客様と復帰）
 */
app.post('/cancelTransfer', async (req, res, next) => {
    const { conversation_uuid, operator_user_id } = req.body;
    console.log(`🐞 /cancelTransfer called: conv=${conversation_uuid}, operator=${operator_user_id}`);

    try {
        const { confName: confId, consultation } = await findConsultationByOperator(operator_user_id);

        if (!consultation || !(consultation.customerLegId || consultation.transferLegId)) {
            return res.status(404).send('Active consultation session not found');
        }

        // 1. 転送先のみを切断
        if (consultation.transferLegId) {
            console.log(`🐞 Hanging up transfer leg: ${consultation.transferLegId}`);
            try {
                await vonage.voice.hangupCall(consultation.transferLegId);
            } catch (err) {
                console.warn(`⚠️ Failed to hangup transfer leg: ${err.message}`);
            }
            await clearConsultationLeg(confId, 'transferLegId', consultation.transferLegId);
        }

        // 2. お客様を通常の会議（保留音なし）に引き戻す
        if (consultation.customerLegId) {
            console.log(`🐞 Reconnecting customer ${consultation.customerLegId} to operator (and stopping any streams)`);
            // API経由のストリームも念のため停止
            await vonage.voice.stopStreamAudio(consultation.customerLegId).catch(() => {});
            
            const resumeNcco = [{ 
                action: 'conversation', 
                name: `${confId}`,
                startConferenceOnEnter: true
            }];
            await vonage.voice.transferCallWithNCCO(consultation.customerLegId, resumeNcco);
        }

        res.status(200).send('Transfer canceled and customer reconnected');
    } catch (e) {
        console.error('🐞 /cancelTransfer Error:', e.message);
        res.status(500).send(e.message);
    }
});

/**
 * ユーザー一覧を取得するエンドポイント（転送先の選択用）
 * FileMaker ODataから待受中のオペレーター一覧を取得します
 */
app.get('/api/users', async (req, res, next) => {
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${BASIC_AUTH}`
        }
        
        // FileMakerから待受中のオペレーター一覧を取得
        const response = await axios.get(
            `${CLARIS_SERVER}/Operator_Status?$top=100&$select=UserID,Status&$filter=Status eq '待受中'&$orderby=LastCallTime asc`,
            { headers }
        );
        
        const operators = response.data.value || [];
        
        // 転送に必要な name（ユーザーID）と表示用の display_name を抽出して返す
        const userList = operators.map(op => ({
            name: op.UserID,
            displayName: op.UserID
        }));
        
        res.json(userList);
    } catch (e) {
        console.error('Error fetching FileMaker users:', e.message);
        if (e.response) {
            console.error(e.response.data);
            res.status(e.response.status).send(e.response.data);
        } else {
            res.status(500).send(e.message);
        }
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});