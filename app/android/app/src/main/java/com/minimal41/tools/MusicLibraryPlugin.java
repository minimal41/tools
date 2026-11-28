package com.minimal41.tools;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Size;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 端末に入っている音楽ファイルの一覧（MediaStore）と、ジャケット画像の取り出し。
 *
 * MediaStore の曲名・アーティスト・アルバムは、Android がファイルの ID3 タグから読み取ったもの。
 * ジャケットは曲ファイルに埋め込まれた画像（ID3 の APIC）を取り出して、アプリのキャッシュに JPEG で保存する。
 */
@CapacitorPlugin(
    name = "MusicLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class MusicLibraryPlugin extends Plugin {

    private static final int ART_SIZE = 600;
    private final ExecutorService worker = Executors.newFixedThreadPool(2);

    private String audioAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
    }

    private boolean granted() {
        return getPermissionState(audioAlias()) == PermissionState.GRANTED;
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", granted());
        call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (granted()) {
            checkPermission(call);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // 再生中の通知（ロック画面の操作）のために通知の許可も一緒にもらう
            requestPermissionForAliases(new String[] { "audio", "notifications" }, call, "permissionCallback");
        } else {
            requestPermissionForAlias("storage", call, "permissionCallback");
        }
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        checkPermission(call);
    }

    /** 端末の音楽ファイルをすべて返す */
    @PluginMethod
    public void scan(PluginCall call) {
        if (!granted()) {
            call.reject("音楽ファイルを読む許可がありません。", "NO_PERMISSION");
            return;
        }
        worker.execute(() -> {
            try {
                call.resolve(queryTracks());
            } catch (Exception e) {
                call.reject("曲の一覧を読み込めませんでした: " + e.getMessage(), e);
            }
        });
    }

    private JSObject queryTracks() {
        ContentResolver resolver = getContext().getContentResolver();
        Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;

        String pathColumn = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? MediaStore.Audio.Media.RELATIVE_PATH : MediaStore.Audio.Media.DATA;
        String[] projection = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.ALBUM_ID,
            "album_artist",
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.TRACK,
            MediaStore.Audio.Media.YEAR,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.SIZE,
            pathColumn
        };

        JSArray tracks = new JSArray();
        try (Cursor c = resolver.query(collection, projection, null, null, MediaStore.Audio.Media.TITLE + " ASC")) {
            if (c != null) {
                int cId = c.getColumnIndex(MediaStore.Audio.Media._ID);
                int cTitle = c.getColumnIndex(MediaStore.Audio.Media.TITLE);
                int cArtist = c.getColumnIndex(MediaStore.Audio.Media.ARTIST);
                int cAlbum = c.getColumnIndex(MediaStore.Audio.Media.ALBUM);
                int cAlbumId = c.getColumnIndex(MediaStore.Audio.Media.ALBUM_ID);
                int cAlbumArtist = c.getColumnIndex("album_artist");
                int cDuration = c.getColumnIndex(MediaStore.Audio.Media.DURATION);
                int cTrack = c.getColumnIndex(MediaStore.Audio.Media.TRACK);
                int cYear = c.getColumnIndex(MediaStore.Audio.Media.YEAR);
                int cName = c.getColumnIndex(MediaStore.Audio.Media.DISPLAY_NAME);
                int cMime = c.getColumnIndex(MediaStore.Audio.Media.MIME_TYPE);
                int cAdded = c.getColumnIndex(MediaStore.Audio.Media.DATE_ADDED);
                int cSize = c.getColumnIndex(MediaStore.Audio.Media.SIZE);
                int cPath = c.getColumnIndex(pathColumn);

                while (c.moveToNext()) {
                    long id = c.getLong(cId);
                    JSObject t = new JSObject();
                    t.put("id", String.valueOf(id));
                    t.put("uri", ContentUris.withAppendedId(collection, id).toString());
                    t.put("title", str(c, cTitle));
                    t.put("artist", str(c, cArtist));
                    t.put("album", str(c, cAlbum));
                    t.put("albumId", cAlbumId >= 0 ? String.valueOf(c.getLong(cAlbumId)) : "");
                    t.put("albumArtist", str(c, cAlbumArtist));
                    t.put("duration", cDuration >= 0 ? c.getLong(cDuration) : 0);
                    // TRACK は「ディスク番号 × 1000 + トラック番号」
                    int track = cTrack >= 0 ? c.getInt(cTrack) : 0;
                    t.put("disc", track / 1000);
                    t.put("track", track % 1000);
                    t.put("year", cYear >= 0 ? c.getInt(cYear) : 0);
                    t.put("fileName", str(c, cName));
                    t.put("mime", str(c, cMime));
                    t.put("added", cAdded >= 0 ? c.getLong(cAdded) : 0);
                    t.put("size", cSize >= 0 ? c.getLong(cSize) : 0);
                    t.put("path", str(c, cPath));
                    tracks.put(t);
                }
            }
        }
        JSObject r = new JSObject();
        r.put("tracks", tracks);
        return r;
    }

    private static String str(Cursor c, int i) {
        if (i < 0 || c.isNull(i)) return "";
        String s = c.getString(i);
        return s == null ? "" : s;
    }

    /**
     * ジャケット画像のファイルの場所を返す（無ければ path: null）。
     * 引数: uri（曲の content:// URI）、albumId、key（キャッシュの名前。省略時は albumId）
     */
    @PluginMethod
    public void artwork(PluginCall call) {
        String uri = call.getString("uri", "");
        String albumId = call.getString("albumId", "");
        String key = call.getString("key", albumId.isEmpty() ? null : "a" + albumId);
        if (key == null || uri.isEmpty()) {
            call.reject("uri と albumId（または key）が必要です。");
            return;
        }
        final String safeKey = key.replaceAll("[^A-Za-z0-9_-]", "_");
        worker.execute(() -> {
            JSObject r = new JSObject();
            try {
                File f = artFile(safeKey);
                if (!f.exists()) {
                    File none = new File(f.getParentFile(), safeKey + ".none");
                    if (!none.exists()) {
                        Bitmap bmp = loadArtwork(Uri.parse(uri), albumId);
                        if (bmp != null) {
                            try (FileOutputStream out = new FileOutputStream(f)) {
                                bmp.compress(Bitmap.CompressFormat.JPEG, 88, out);
                            }
                            bmp.recycle();
                        } else {
                            none.createNewFile();
                        }
                    }
                }
                r.put("path", f.exists() ? f.getAbsolutePath() : null);
            } catch (Exception e) {
                r.put("path", null);
            }
            call.resolve(r);
        });
    }

    /** 保存したジャケット画像を消す（曲を入れ替えたときなどに） */
    @PluginMethod
    public void clearArtworkCache(PluginCall call) {
        worker.execute(() -> {
            File dir = new File(getContext().getCacheDir(), "art");
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) f.delete();
            call.resolve();
        });
    }

    static File artFile(android.content.Context ctx, String key) {
        File dir = new File(ctx.getCacheDir(), "art");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, key + ".jpg");
    }

    private File artFile(String key) {
        return artFile(getContext(), key);
    }

    private Bitmap loadArtwork(Uri trackUri, String albumId) {
        // 1. 曲ファイルに埋め込まれた画像（ID3 の APIC）
        MediaMetadataRetriever mmr = new MediaMetadataRetriever();
        try {
            mmr.setDataSource(getContext(), trackUri);
            byte[] pic = mmr.getEmbeddedPicture();
            if (pic != null) {
                Bitmap b = decodeSampled(pic);
                if (b != null) return b;
            }
        } catch (Exception ignored) {
        } finally {
            try {
                mmr.release();
            } catch (Exception ignored) {}
        }

        ContentResolver resolver = getContext().getContentResolver();
        // 2. Android が用意しているサムネイル（フォルダの cover.jpg なども拾う）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                return scale(resolver.loadThumbnail(trackUri, new Size(ART_SIZE, ART_SIZE), null));
            } catch (Exception ignored) {}
        } else if (!albumId.isEmpty()) {
            // 3. 古い Android のアルバムアート
            try (InputStream in = resolver.openInputStream(
                    ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), Long.parseLong(albumId)))) {
                if (in != null) return scale(BitmapFactory.decodeStream(in));
            } catch (Exception ignored) {}
        }
        return null;
    }

    private static Bitmap decodeSampled(byte[] data) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, o);
        int sample = 1;
        while (o.outWidth / (sample * 2) >= ART_SIZE && o.outHeight / (sample * 2) >= ART_SIZE) sample *= 2;
        BitmapFactory.Options o2 = new BitmapFactory.Options();
        o2.inSampleSize = sample;
        return scale(BitmapFactory.decodeByteArray(data, 0, data.length, o2));
    }

    private static Bitmap scale(Bitmap b) {
        if (b == null) return null;
        int w = b.getWidth(), h = b.getHeight();
        int max = Math.max(w, h);
        if (max <= ART_SIZE) return b;
        float k = (float) ART_SIZE / max;
        Bitmap s = Bitmap.createScaledBitmap(b, Math.round(w * k), Math.round(h * k), true);
        if (s != b) b.recycle();
        return s;
    }
}
