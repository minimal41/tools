package com.minimal41.tools;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import java.util.HashMap;
import java.util.Map;

/**
 * 再生回数を数える（再生サービスの中で動くので、画面を消していても数えられる）。
 *
 * 1 曲を 30 秒（短い曲は長さの半分）以上聴いたら 1 回と数える。
 * 回数は端末の中（SharedPreferences）に、曲の id ごとに保存する。
 */
final class PlayCounter implements Player.Listener {

    interface Listener {
        void onCounted(String id, int count);
    }

    private static final String PREFS = "play_counts";
    private static final long THRESHOLD_MS = 30_000;

    /** ページ側（MusicPlayerPlugin）が知らせを受け取る */
    @Nullable
    static volatile Listener listener;

    private final Context context;
    private final Player player;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable check = this::check;

    @Nullable
    private String currentId;
    private long listened = 0;
    private long startedAt = -1;
    private boolean counted = false;

    PlayCounter(Context context, Player player) {
        this.context = context.getApplicationContext();
        this.player = player;
        player.addListener(this);
    }

    void release() {
        handler.removeCallbacks(check);
        player.removeListener(this);
    }

    static Map<String, Integer> all(Context context) {
        Map<String, Integer> out = new HashMap<>();
        for (Map.Entry<String, ?> e : prefs(context).getAll().entrySet()) {
            if (e.getValue() instanceof Integer) out.put(e.getKey(), (Integer) e.getValue());
        }
        return out;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void onMediaItemTransition(@Nullable MediaItem item, int reason) {
        // 曲が変わった（1 曲リピートで頭に戻ったときも）→ 数え直す
        currentId = item != null ? item.mediaId : null;
        listened = 0;
        counted = false;
        startedAt = player.isPlaying() ? SystemClock.elapsedRealtime() : -1;
        schedule();
    }

    @Override
    public void onIsPlayingChanged(boolean isPlaying) {
        long now = SystemClock.elapsedRealtime();
        if (isPlaying) {
            if (currentId == null) {
                MediaItem item = player.getCurrentMediaItem();
                currentId = item != null ? item.mediaId : null;
            }
            startedAt = now;
            schedule();
        } else {
            if (startedAt >= 0) listened += now - startedAt;
            startedAt = -1;
            handler.removeCallbacks(check);
            check();
        }
    }

    private long threshold() {
        long d = player.getDuration();
        if (d == C.TIME_UNSET || d <= 0) return THRESHOLD_MS;
        return Math.min(THRESHOLD_MS, Math.max(1000, d / 2));
    }

    private long heard() {
        return listened + (startedAt >= 0 ? SystemClock.elapsedRealtime() - startedAt : 0);
    }

    private void schedule() {
        handler.removeCallbacks(check);
        if (!counted && currentId != null && player.isPlaying()) {
            handler.postDelayed(check, Math.max(200, threshold() - heard() + 100));
        }
    }

    private void check() {
        if (counted || currentId == null) return;
        if (heard() >= threshold()) {
            counted = true;
            SharedPreferences p = prefs(context);
            int n = p.getInt(currentId, 0) + 1;
            p.edit().putInt(currentId, n).apply();
            Listener l = listener;
            if (l != null) l.onCounted(currentId, n);
        } else {
            schedule();
        }
    }
}
