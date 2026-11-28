package com.minimal41.tools;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * 音楽を再生するサービス。
 *
 * アプリを閉じたり画面を消したりしても再生を続け、通知・ロック画面・イヤホンのボタン・ウィジェットから操作できる
 * （Media3 の MediaSessionService が、再生中はフォアグラウンドサービスとして通知を出す）。
 * 再生キューはファイルに保存し、アプリを閉じたあとでもウィジェットなどの ▶︎ で続きから再生できる。
 */
public class PlaybackService extends MediaSessionService {

    @Nullable
    private static PlaybackService instance;

    @Nullable
    private MediaSession session;

    @Nullable
    private PlayCounter counter;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable saveQueue = () -> {
        if (session != null) QueueStore.save(this, session.getPlayer());
    };

    /** 動いている再生サービスのプレーヤー（無ければ null）。ウィジェットが使う */
    @Nullable
    static Player currentPlayer() {
        PlaybackService s = instance;
        return s != null && s.session != null ? s.session.getPlayer() : null;
    }

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onEvents(Player player, Player.Events events) {
            if (events.containsAny(
                Player.EVENT_MEDIA_ITEM_TRANSITION,
                Player.EVENT_MEDIA_METADATA_CHANGED,
                Player.EVENT_PLAY_WHEN_READY_CHANGED,
                Player.EVENT_IS_PLAYING_CHANGED,
                Player.EVENT_TIMELINE_CHANGED
            )) {
                MusicWidget.update(PlaybackService.this, player);
            }
            if (events.containsAny(
                Player.EVENT_MEDIA_ITEM_TRANSITION,
                Player.EVENT_TIMELINE_CHANGED,
                Player.EVENT_IS_PLAYING_CHANGED,
                Player.EVENT_POSITION_DISCONTINUITY
            )) {
                // まとめて 1 秒後に保存
                main.removeCallbacks(saveQueue);
                main.postDelayed(saveQueue, 1000);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ExoPlayer player = new ExoPlayer.Builder(this)
            .setAudioAttributes(
                new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
                true // ほかのアプリが音を出したら一時停止する（オーディオフォーカス）
            )
            .setHandleAudioBecomingNoisy(true) // イヤホンが抜けたら一時停止
            .setWakeMode(C.WAKE_MODE_LOCAL) // 画面が消えても止まらないようにする
            .build();
        counter = new PlayCounter(this, player);
        player.addListener(listener);

        // 通知をタップしたらアプリの Music を開く
        Intent open = new Intent(this, MainActivity.class);
        open.setAction("com.minimal41.tools.OPEN_MUSIC");
        open.putExtra(MainActivity.EXTRA_OPEN, "music");
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session = new MediaSession.Builder(this, player)
            .setSessionActivity(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .setCallback(new Callback())
            .build();
    }

    /** アプリを閉じたあと、ウィジェットやイヤホンの ▶︎ で呼ばれる：保存してある再生キューの続きから */
    private final class Callback implements MediaSession.Callback {
        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller
        ) {
            QueueStore.Saved s = QueueStore.load(PlaybackService.this);
            if (s == null) return Futures.immediateFailedFuture(new UnsupportedOperationException("再生キューがありません"));
            return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(s.items, s.index, s.position));
        }

        @Override
        public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
            MediaSession mediaSession,
            MediaSession.ControllerInfo controller,
            boolean isForPlayback
        ) {
            return onPlaybackResumption(mediaSession, controller);
        }
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
        main.removeCallbacks(saveQueue);
        if (session != null) {
            Player p = session.getPlayer();
            if (p.getMediaItemCount() > 0) QueueStore.save(this, p);
            p.removeListener(listener);
        }
        if (counter != null) {
            counter.release();
            counter = null;
        }
        if (session != null) {
            session.getPlayer().release();
            session.release();
            session = null;
        }
        instance = null;
        // ウィジェットは最後の曲のまま、▶︎ の表示にしておく
        MusicWidget.showSaved(this);
        super.onDestroy();
    }
}
