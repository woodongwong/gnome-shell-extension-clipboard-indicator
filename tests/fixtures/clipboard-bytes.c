#include <glib.h>

typedef void (*ClipboardBytesCallback) (GBytes *bytes, gpointer user_data);

static guint releases;

static void release_buffer (gpointer data)
{
    releases++;
    g_free (data);
}

/* Same ownership boundary as StClipboardContentCallbackFunc: the bytes are
 * borrowed during the callback, then the native producer drops its reference.
 * A destroy notifier lets tests detect a dangling buffer without reading it.
 */
void clipboard_bytes_deliver (ClipboardBytesCallback callback, gpointer user_data)
{
    const char text[] = "callback 中文 😀";
    gpointer data = g_memdup2 (text, sizeof text - 1);
    GBytes *bytes = g_bytes_new_with_free_func (data, sizeof text - 1,
                                               release_buffer, data);
    callback (bytes, user_data);
    g_bytes_unref (bytes);
}

guint clipboard_bytes_get_releases (void)
{
    return releases;
}
