package com.minimal41.tools;

import android.content.ComponentName;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * ページ（JavaScript）から PlaybackService の再生を操作する。
 *
 * 再生そのものはサービスの中で行うので、ページを閉じても・画面を消しても止まらない。
 * 状態が変わると "state" イベントで知らせる。
 */
@CapacitorPlugin(name = "MusicPlayer")
public class MusicPlayerPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Consumer<MediaController>> pending = new ArrayList<>();
    private ListenableFuture<MediaController> future;
    private MediaController controller;
    private String lastError = null;

    private final Player.Listener listener = new Player.Listener() {
        @Override
        public void onEvents(Player player, Player.Events events) {
            notifyListeners("state", state(player, false));
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            lastError = error.getMessage();
            JSObject e = new JSObject();
            e.put("message", error.getMessage());
            e.put("code", error.getErrorCodeName());
            notifyListeners("error", e);
        }
    };

    private final PlayCounter.Listener playListener = (id, count) -> {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("count", count);
        notifyListeners("played", e);
    };

    @Override
    public void load() {
        PlayCounter.listener = playListener;
        main.post(this::connect);
    }

    /** 曲ごとの再生回数 { counts: { id: 回数 } } */
    @PluginMethod
    public void getPlayCounts(PluginCall call) {
        JSObject counts = new JSObject();
        for (java.util.Map.Entry<String, Integer> e : PlayCounter.all(getContext()).entrySet()) {
            counts.put(e.getKey(), (int) e.getValue());
        }
        JSObject r = new JSObject();
        r.put("counts", counts);
        call.resolve(r);
    }

    private void connect() {
        if (future != null) return;
        SessionToken token = new SessionToken(getContext(), new ComponentName(getContext(), PlaybackService.class));
        future = new MediaController.Builder(getContext(), token).buildAsync();
        future.addListener(
            () -> {
                try {
                    controller = future.get();
                    controller.addListener(listener);
                    List<Consumer<MediaController>> todo = new ArrayList<>(pending);
                    pending.clear();
                    for (Consumer<MediaController> fn : todo) fn.accept(controller);
                    notifyListeners("state", state(controller, false));
                } catch (Exception e) {
                    future = null;
                    controller = null;
                    List<Consumer<MediaController>> todo = new ArrayList<>(pending);
                    pending.clear();
                    for (Consumer<MediaController> fn : todo) fn.accept(null);
                }
            },
            ContextCompat.getMainExecutor(getContext())
        );
    }

    /** 再生サービスにつながってから fn を実行する（メインスレッド） */
    private void withController(PluginCall call, Consumer<MediaController> fn) {
        main.post(() -> {
            if (controller != null && !controller.isConnected()) {
                // サービスが終わっていたらつなぎ直す
                controller.release();
                controller = null;
                future = null;
            }
            if (controller != null) {
                run(call, fn, controller);
                return;
            }
            pending.add((c) -> {
                if (c == null) call.reject("再生サービスに接続できませんでした。");
                else run(call, fn, c);
            });
            connect();
        });
    }

    private void run(PluginCall call, Consumer<MediaController> fn, MediaController c) {
        try {
            fn.accept(c);
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), e);
        }
    }

    private void done(PluginCall call, MediaController c) {
        call.resolve(state(c, false));
    }

    /**
     * 再生する曲の並びをまとめて渡す。
     * tracks: [{ id, uri, title, artist, album, albumId }], index, position（ミリ秒）, play（true で再生開始）
     */
    @PluginMethod
    public void setQueue(PluginCall call) {
        JSArray tracks = call.getArray("tracks", new JSArray());
        int index = call.getInt("index", 0);
        long position = call.getLong("position", 0L);
        boolean play = call.getBoolean("play", true);

        List<MediaItem> items = new ArrayList<>();
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject t = tracks.optJSONObject(i);
            if (t == null) continue;
            items.add(toItem(t));
        }
        if (items.isEmpty()) {
            call.reject("曲がありません。");
            return;
        }
        final int start = Math.max(0, Math.min(index, items.size() - 1));
        withController(call, (c) -> {
            c.setMediaItems(items, start, Math.max(0, position));
            c.prepare();
            if (play) c.play();
            else c.pause();
            done(call, c);
        });
    }

    private MediaItem toItem(JSONObject t) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .setTitle(t.optString("title", ""))
            .setArtist(t.optString("artist", ""))
            .setAlbumTitle(t.optString("album", ""))
            .setAlbumArtist(t.optString("albumArtist", ""));
        String albumId = t.optString("albumId", "");
        if (!albumId.isEmpty()) {
            // ページで一度取り出したジャケットがあれば通知・ロック画面にも出す
            // （無いときも、再生が始まると曲ファイルに埋め込まれた画像が使われる）
            File art = MusicLibraryPlugin.artFile(getContext(), "a" + albumId.replaceAll("[^A-Za-z0-9_-]", "_"));
            if (art.exists()) meta.setArtworkUri(Uri.fromFile(art));
        }
        return new MediaItem.Builder()
            .setMediaId(t.optString("id", t.optString("uri")))
            .setUri(Uri.parse(t.optString("uri")))
            .setMediaMetadata(meta.build())
            .build();
    }

    @PluginMethod
    public void play(PluginCall call) {
        withController(call, (c) -> {
            if (c.getPlaybackState() == Player.STATE_IDLE) c.prepare();
            if (c.getPlaybackState() == Player.STATE_ENDED) c.seekTo(c.getCurrentMediaItemIndex(), 0);
            c.play();
            done(call, c);
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        withController(call, (c) -> {
            c.pause();
            done(call, c);
        });
    }

    @PluginMethod
    public void next(PluginCall call) {
        withController(call, (c) -> {
            if (c.hasNextMediaItem()) c.seekToNextMediaItem();
            done(call, c);
        });
    }

    /** 3 秒以上再生していたら曲の頭へ、そうでなければ前の曲へ */
    @PluginMethod
    public void previous(PluginCall call) {
        withController(call, (c) -> {
            c.seekToPrevious();
            done(call, c);
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        long position = call.getLong("position", 0L);
        withController(call, (c) -> {
            c.seekTo(Math.max(0, position));
            done(call, c);
        });
    }

    @PluginMethod
    public void skipTo(PluginCall call) {
        int index = call.getInt("index", 0);
        withController(call, (c) -> {
            if (index >= 0 && index < c.getMediaItemCount()) {
                c.seekTo(index, 0);
                c.play();
            }
            done(call, c);
        });
    }

    @PluginMethod
    public void setShuffle(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        withController(call, (c) -> {
            c.setShuffleModeEnabled(on);
            done(call, c);
        });
    }

    /** mode: "off" / "all" / "one" */
    @PluginMethod
    public void setRepeat(PluginCall call) {
        String mode = call.getString("mode", "off");
        withController(call, (c) -> {
            c.setRepeatMode("one".equals(mode) ? Player.REPEAT_MODE_ONE : "all".equals(mode) ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
            done(call, c);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        withController(call, (c) -> {
            c.stop();
            c.clearMediaItems();
            done(call, c);
        });
    }

    /** いまの状態。queue: true で、並んでいる曲の id も返す */
    @PluginMethod
    public void getState(PluginCall call) {
        boolean withQueue = call.getBoolean("queue", false);
        withController(call, (c) -> call.resolve(state(c, withQueue)));
    }

    private JSObject state(Player p, boolean withQueue) {
        JSObject s = new JSObject();
        s.put("playing", p.isPlaying());
        s.put("playWhenReady", p.getPlayWhenReady());
        s.put("buffering", p.getPlaybackState() == Player.STATE_BUFFERING);
        s.put("ended", p.getPlaybackState() == Player.STATE_ENDED);
        s.put("index", p.getCurrentMediaItemIndex());
        s.put("count", p.getMediaItemCount());
        MediaItem item = p.getCurrentMediaItem();
        s.put("id", item != null ? item.mediaId : null);
        s.put("position", Math.max(0, p.getCurrentPosition()));
        long d = p.getDuration();
        s.put("duration", d == C.TIME_UNSET ? 0 : d);
        s.put("shuffle", p.getShuffleModeEnabled());
        int r = p.getRepeatMode();
        s.put("repeat", r == Player.REPEAT_MODE_ONE ? "one" : r == Player.REPEAT_MODE_ALL ? "all" : "off");
        if (lastError != null) s.put("error", lastError);
        if (withQueue) {
            JSArray ids = new JSArray();
            for (int i = 0; i < p.getMediaItemCount(); i++) ids.put(p.getMediaItemAt(i).mediaId);
            s.put("queue", ids);
        }
        return s;
    }

    @Override
    protected void handleOnDestroy() {
        if (PlayCounter.listener == playListener) PlayCounter.listener = null;
        // ページ側の接続だけ切る（サービスは再生中ならそのまま続く）
        main.post(() -> {
            if (controller != null) controller.removeListener(listener);
            if (future != null) MediaController.releaseFuture(future);
            controller = null;
            future = null;
        });
    }
}
