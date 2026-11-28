package com.minimal41.tools;

import android.content.Context;
import android.net.Uri;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 再生キュー（曲の並び・いまの曲・位置）をアプリの中のファイルに保存する。
 *
 * アプリを完全に閉じたあとでも、ウィジェットやイヤホンの ▶︎ で続きから再生できるようにするため
 * （Media3 の「再生の再開」で読み出す）。
 */
final class QueueStore {

    private static final String FILE = "queue.json";
    private static final ExecutorService io = Executors.newSingleThreadExecutor();

    static final class Saved {
        final List<MediaItem> items;
        final int index;
        final long position;

        Saved(List<MediaItem> items, int index, long position) {
            this.items = items;
            this.index = index;
            this.position = position;
        }
    }

    private QueueStore() {}

    /** ページから受け取った曲の情報 → 再生する MediaItem */
    static MediaItem toItem(Context ctx, JSONObject t) {
        MediaMetadata.Builder meta = new MediaMetadata.Builder()
            .setTitle(t.optString("title", ""))
            .setArtist(t.optString("artist", ""))
            .setAlbumTitle(t.optString("album", ""))
            .setAlbumArtist(t.optString("albumArtist", ""));
        String albumId = t.optString("albumId", "");
        android.os.Bundle extras = new android.os.Bundle();
        extras.putString("albumId", albumId);
        meta.setExtras(extras);
        if (!albumId.isEmpty()) {
            // ページで一度取り出したジャケットがあれば通知・ロック画面・ウィジェットにも出す
            // （無いときも、再生が始まると曲ファイルに埋め込まれた画像が使われる）
            File art = MusicLibraryPlugin.artFile(ctx, "a" + albumId.replaceAll("[^A-Za-z0-9_-]", "_"));
            if (art.exists()) meta.setArtworkUri(Uri.fromFile(art));
        }
        return new MediaItem.Builder()
            .setMediaId(t.optString("id", t.optString("uri")))
            .setUri(Uri.parse(t.optString("uri")))
            .setMediaMetadata(meta.build())
            .build();
    }

    private static JSONObject toJson(MediaItem item) throws Exception {
        JSONObject o = new JSONObject();
        MediaMetadata m = item.mediaMetadata;
        o.put("id", item.mediaId);
        o.put("uri", item.localConfiguration != null ? item.localConfiguration.uri.toString() : "");
        o.put("title", m.title != null ? m.title.toString() : "");
        o.put("artist", m.artist != null ? m.artist.toString() : "");
        o.put("album", m.albumTitle != null ? m.albumTitle.toString() : "");
        o.put("albumArtist", m.albumArtist != null ? m.albumArtist.toString() : "");
        o.put("albumId", m.extras != null ? m.extras.getString("albumId", "") : "");
        return o;
    }

    /** いまの再生キューを保存（メインスレッドで呼ぶ。書き込みは裏で） */
    static void save(Context ctx, Player p) {
        try {
            JSONArray items = new JSONArray();
            for (int i = 0; i < p.getMediaItemCount(); i++) items.put(toJson(p.getMediaItemAt(i)));
            JSONObject o = new JSONObject();
            o.put("items", items);
            o.put("index", p.getCurrentMediaItemIndex());
            o.put("position", Math.max(0, p.getCurrentPosition()));
            final byte[] data = o.toString().getBytes(StandardCharsets.UTF_8);
            final File f = new File(ctx.getFilesDir(), FILE);
            io.execute(() -> {
                File tmp = new File(f.getPath() + ".tmp");
                try (FileOutputStream out = new FileOutputStream(tmp)) {
                    out.write(data);
                } catch (Exception e) {
                    return;
                }
                tmp.renameTo(f);
            });
        } catch (Exception ignored) {}
    }

    @Nullable
    static Saved load(Context ctx) {
        File f = new File(ctx.getFilesDir(), FILE);
        if (!f.exists()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) f.length()];
            int off = 0;
            while (off < buf.length) {
                int n = in.read(buf, off, buf.length - off);
                if (n < 0) break;
                off += n;
            }
            JSONObject o = new JSONObject(new String(buf, 0, off, StandardCharsets.UTF_8));
            JSONArray arr = o.optJSONArray("items");
            if (arr == null || arr.length() == 0) return null;
            List<MediaItem> items = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject t = arr.optJSONObject(i);
                if (t != null && !t.optString("uri").isEmpty()) items.add(toItem(ctx, t));
            }
            if (items.isEmpty()) return null;
            int index = Math.max(0, Math.min(o.optInt("index", 0), items.size() - 1));
            return new Saved(items, index, o.optLong("position", 0));
        } catch (Exception e) {
            return null;
        }
    }
}
