package com.minimal41.tools;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * 音楽を再生するサービス。
 *
 * アプリを閉じたり画面を消したりしても再生を続け、通知・ロック画面・イヤホンのボタンから操作できる
 * （Media3 の MediaSessionService が、再生中はフォアグラウンドサービスとして通知を出す）。
 */
public class PlaybackService extends MediaSessionService {

    @Nullable
    private MediaSession session;

    @Nullable
    private PlayCounter counter;

    @Override
    public void onCreate() {
        super.onCreate();
        ExoPlayer player = new ExoPlayer.Builder(this)
            .setAudioAttributes(
                new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                true // ほかのアプリが音を出したら一時停止する（オーディオフォーカス）
            )
            .setHandleAudioBecomingNoisy(true) // イヤホンが抜けたら一時停止
            .setWakeMode(C.WAKE_MODE_LOCAL) // 画面が消えても止まらないようにする
            .build();
        counter = new PlayCounter(this, player);

        // 通知をタップしたらアプリを開く
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        MediaSession.Builder builder = new MediaSession.Builder(this, player);
        if (open != null) {
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            builder.setSessionActivity(
                PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
            );
        }
        session = builder.build();
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /** 最近使ったアプリの一覧からスワイプで消されたとき：再生中なら続け、止まっていれば終わる */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        if (session != null) {
            Player p = session.getPlayer();
            if (!p.getPlayWhenReady() || p.getMediaItemCount() == 0 || p.getPlaybackState() == Player.STATE_ENDED) {
                stopSelf();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (counter != null) {
            counter.release();
            counter = null;
        }
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        super.onDestroy();
    }
}
