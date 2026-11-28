package com.minimal41.tools;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.view.KeyEvent;
import android.widget.RemoteViews;
import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.session.MediaButtonReceiver;
import java.io.File;

/**
 * ホーム画面の Music ウィジェット。
 *
 * ジャケット・曲名・アーティストと、前の曲 / 再生・一時停止 / 次の曲 のボタン。
 * 曲名のところを押すとアプリの Music が開く。
 * ボタンはイヤホンのボタンと同じしくみ（MEDIA_BUTTON）で再生サービスに届くので、
 * アプリを閉じていても ▶︎ で前回の続きから再生できる。
 */
public class MusicWidget extends AppWidgetProvider {

    private static final int ART_PX = 192;

    /** 最後に表示した内容（サービスが止まったあとも同じ曲を出しておく） */
    private static String lastTitle = null;
    private static String lastArtist = null;
    private static String lastArtKey = null;
    private static Bitmap lastArt = null;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        Player p = PlaybackService.currentPlayer();
        if (p != null) {
            update(context, p);
        } else {
            showSaved(context);
        }
    }

    /** 再生サービスの状態からウィジェットを書き換える（メインスレッドで呼ぶ） */
    static void update(Context context, Player p) {
        MediaItem item = p.getCurrentMediaItem();
        if (item == null) {
            showSaved(context);
            return;
        }
        MediaMetadata m = p.getMediaMetadata();
        String title = m.title != null ? m.title.toString() : "";
        String artist = m.artist != null ? m.artist.toString() : "";
        lastTitle = title;
        lastArtist = artist;
        Bitmap art = artwork(context, item, m);
        render(context, title, artist, art, p.getPlayWhenReady());
    }

    /** サービスが動いていないとき：保存してある再生キューの曲を出す */
    static void showSaved(Context context) {
        if (lastTitle == null) {
            QueueStore.Saved s = QueueStore.load(context);
            if (s != null) {
                MediaItem item = s.items.get(s.index);
                MediaMetadata m = item.mediaMetadata;
                lastTitle = m.title != null ? m.title.toString() : "";
                lastArtist = m.artist != null ? m.artist.toString() : "";
                lastArt = artwork(context, item, m);
            }
        }
        render(context, lastTitle, lastArtist, lastArt, false);
    }

    private static void render(Context context, @Nullable String title, @Nullable String artist, @Nullable Bitmap art, boolean playing) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, MusicWidget.class));
        if (ids == null || ids.length == 0) return;

        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_music);
        boolean empty = title == null || title.isEmpty();
        v.setTextViewText(R.id.widget_title, empty ? "Music" : title);
        v.setTextViewText(R.id.widget_artist, empty ? "タップして曲を選ぶ" : (artist == null || artist.isEmpty() ? "不明なアーティスト" : artist));
        if (art != null) v.setImageViewBitmap(R.id.widget_art, art);
        else v.setImageViewResource(R.id.widget_art, R.drawable.widget_art_placeholder);

        v.setImageViewResource(R.id.widget_play, playing ? R.drawable.ic_w_pause : R.drawable.ic_w_play);
        v.setContentDescription(R.id.widget_play, playing ? "一時停止" : "再生");

        v.setOnClickPendingIntent(R.id.widget_info, openMusic(context));
        v.setOnClickPendingIntent(R.id.widget_prev, mediaButton(context, KeyEvent.KEYCODE_MEDIA_PREVIOUS));
        v.setOnClickPendingIntent(R.id.widget_play, mediaButton(context, playing ? KeyEvent.KEYCODE_MEDIA_PAUSE : KeyEvent.KEYCODE_MEDIA_PLAY));
        v.setOnClickPendingIntent(R.id.widget_next, mediaButton(context, KeyEvent.KEYCODE_MEDIA_NEXT));

        manager.updateAppWidget(ids, v);
    }

    /** アプリの Music を開く */
    private static PendingIntent openMusic(Context context) {
        Intent i = new Intent(context, MainActivity.class);
        i.setAction("com.minimal41.tools.OPEN_MUSIC");
        i.putExtra(MainActivity.EXTRA_OPEN, "music");
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** イヤホンのボタンと同じ知らせを再生サービスへ送る */
    private static PendingIntent mediaButton(Context context, int keyCode) {
        Intent i = new Intent(Intent.ACTION_MEDIA_BUTTON);
        i.setComponent(new ComponentName(context, MediaButtonReceiver.class));
        i.putExtra(Intent.EXTRA_KEY_EVENT, new KeyEvent(KeyEvent.ACTION_DOWN, keyCode));
        return PendingIntent.getBroadcast(context, 100 + keyCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** ジャケット：アプリが保存したもの → 曲ファイルに埋め込まれたもの の順に探す */
    @Nullable
    private static Bitmap artwork(Context context, MediaItem item, MediaMetadata m) {
        String albumId = m.extras != null ? m.extras.getString("albumId", "") : "";
        if (albumId.isEmpty() && item.mediaMetadata.extras != null) albumId = item.mediaMetadata.extras.getString("albumId", "");
        String key = !albumId.isEmpty() ? "a" + albumId : "t" + item.mediaId;
        if (key.equals(lastArtKey) && lastArt != null) return lastArt;

        Bitmap b = null;
        if (!albumId.isEmpty()) {
            File f = MusicLibraryPlugin.artFile(context, "a" + albumId.replaceAll("[^A-Za-z0-9_-]", "_"));
            if (f.exists()) b = decode(f.getAbsolutePath(), null);
        }
        if (b == null && m.artworkData != null) b = decode(null, m.artworkData);
        lastArtKey = key;
        lastArt = b;
        return b;
    }

    @Nullable
    private static Bitmap decode(@Nullable String path, @Nullable byte[] data) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            if (path != null) BitmapFactory.decodeFile(path, o);
            else BitmapFactory.decodeByteArray(data, 0, data.length, o);
            int sample = 1;
            while (o.outWidth / (sample * 2) >= ART_PX && o.outHeight / (sample * 2) >= ART_PX) sample *= 2;
            BitmapFactory.Options o2 = new BitmapFactory.Options();
            o2.inSampleSize = sample;
            Bitmap b = path != null ? BitmapFactory.decodeFile(path, o2) : BitmapFactory.decodeByteArray(data, 0, data.length, o2);
            if (b == null) return null;
            int max = Math.max(b.getWidth(), b.getHeight());
            if (max > ART_PX) {
                float k = (float) ART_PX / max;
                Bitmap s = Bitmap.createScaledBitmap(b, Math.round(b.getWidth() * k), Math.round(b.getHeight() * k), true);
                if (s != b) b.recycle();
                b = s;
            }
            return b;
        } catch (Exception e) {
            return null;
        }
    }
}
