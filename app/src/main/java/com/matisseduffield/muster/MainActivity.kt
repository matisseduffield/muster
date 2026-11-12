package com.matisseduffield.muster

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.matisseduffield.muster.updates.AppUpdates
import org.json.JSONObject

/**
 * Hosts web/index.html (bundled as assets) in a WebView. The asset loader
 * serves it from a real https origin, at the same paths the website uses
 * (/, /g/<id>, /j/<code>), so the page routes exactly as it does in a browser.
 * A message bridge, limited to that origin, lends the page what it can't do
 * alone: the share sheet, a tick under the thumb and the Thursday reminder.
 * Group links opened on the phone, and tapped reminders, open their group.
 */
class MainActivity : ComponentActivity() {
    private companion object {
        const val APP_HOST = WebViewAssetLoader.DEFAULT_DOMAIN
        const val APP_ORIGIN = "https://$APP_HOST"
        const val SITE_HOST = "muster.teloone.au"
        const val BRIDGE_NAME = "musterApp"
        const val STATE_URL = "url"

        // Changes saved on a weak signal keep retrying this long after the app
        // goes out of sight; then the page's timers stop as usual.
        const val UNSENT_GRACE_MS = 10 * 60 * 1000L

        val GROUP_LINK = Regex("^/g/[A-Za-z0-9_-]{22}/?$")
        val CODE_LINK = Regex("^/j/[A-Za-z]{4}/?$")
    }

    private lateinit var web: WebView
    private val updates = AppUpdates(this)
    private var page: JavaScriptReplyProxy? = null
    private var unsent = false
    private var resumed = false
    private var pausedAt = 0L
    private var crashed = false
    private val pauseLater = Runnable { if (!resumed) web.pauseTimers() }
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        send(JSONObject().put("type", "notifications").put("allowed", granted && Reminders.allowed(this)))
    }

    // The page keeps its own history (steps, sheets, groups), so Back walks
    // it. With nothing behind, Back is left to the system and its preview.
    private val pageBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if (web.canGoBack()) web.goBack() else isEnabled = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }

        // The page and a group's or a code's address are all index.html, as on
        // the website; everything else is the file of that name.
        val files = WebViewAssetLoader.AssetsPathHandler(this)
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/") { path ->
                files.handle(if (path.isEmpty() || path.startsWith("g/") || path.startsWith("j/")) "index.html" else path)
            }
            .build()

        web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            // Follow the phone's font size setting.
            settings.textZoom = (resources.configuration.fontScale * 100).toInt()
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assets.shouldInterceptRequest(request.url)

                // If Android ends the page's renderer (low memory), start the
                // screen again rather than letting the whole app crash. A page
                // that crashed starts again from the home screen, so a group
                // that crashes it can't do so over and over.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    crashed = detail.didCrash()
                    recreate()
                    return true
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == APP_HOST) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    return true
                }

                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                    pageBack.isEnabled = view.canGoBack()
                }
            }
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(getColor(R.color.page_bg))
            addView(web)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, BRIDGE_NAME, setOf(APP_ORIGIN)) { _, message, origin, isMainFrame, reply ->
                if (isMainFrame && origin == APP_ORIGIN.toUri()) onPageMessage(message, reply)
            }
        }
        onBackPressedDispatcher.addCallback(this, pageBack)

        // Started again (a theme or font size change, or Android ending the app
        // while it was away): reopen where the page was. The link that first
        // opened the app was taken then, so it isn't again.
        val restored = savedInstanceState?.getString(STATE_URL)?.takeIf(::isOwnPage)
        val linked = if (savedInstanceState == null) linkPath(intent) else null
        web.loadUrl(restored ?: (APP_ORIGIN + (linked ?: "/")))

        updates.start(firstCreate = savedInstanceState == null)
    }

    // Out of sight, the page's timers and syncing stop entirely; they resume
    // (and catch up) as soon as the app is back. Changes not yet sent are the
    // exception: the page keeps retrying them for a while (it says when it has
    // some), and its timers stop once they're sent or the while is up.
    override fun onResume() {
        super.onResume()
        resumed = true
        web.removeCallbacks(pauseLater)
        web.onResume()
        web.resumeTimers()
        // Notifications may have been switched in Settings while the app was away.
        if (page != null) web.evaluateJavascript("window.musterAsk && musterAsk()", null)
        updates.onResume()
    }

    override fun onPause() {
        resumed = false
        pausedAt = System.currentTimeMillis()
        web.onPause()
        if (unsent) web.postDelayed(pauseLater, UNSENT_GRACE_MS) else web.pauseTimers()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!crashed) web.url?.takeIf(::isOwnPage)?.let { outState.putString(STATE_URL, it) }
    }

    override fun onDestroy() {
        web.removeCallbacks(pauseLater)
        web.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        linkPath(intent)?.let { web.loadUrl(APP_ORIGIN + it) }
    }

    /**
     * The page address for a group link or a join code link opened on the
     * phone, or for a tapped reminder. A link that's the wrong shape opens the
     * page that says so.
     */
    private fun linkPath(intent: Intent?): String? {
        val open = intent?.getStringExtra(Reminders.EXTRA_OPEN)
        if (open != null) {
            intent.removeExtra(Reminders.EXTRA_OPEN)
            return open.takeIf { Reminders.GROUP_PATH.matches(it) }
        }
        if (intent?.action != Intent.ACTION_VIEW) return null
        val link = intent.data ?: return null
        intent.data = null
        if (link.scheme != "https" || link.host != SITE_HOST) return null
        val path = link.path ?: return null
        return when {
            GROUP_LINK.matches(path) || CODE_LINK.matches(path) -> path
            path.startsWith("/g/") || path.startsWith("/j/") -> "/g/-"
            else -> null
        }
    }

    private fun onPageMessage(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val msg = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        when (msg.optString("type")) {
            "hello" -> {
                page = reply
                send(JSONObject().put("type", "info").put("version", BuildConfig.VERSION_NAME).put("notifications", Reminders.allowed(this)))
            }
            "unsent" -> {
                unsent = msg.optBoolean("on")
                if (resumed) return
                web.removeCallbacks(pauseLater)
                // Sent while out of sight: nothing left to retry, so stop now. A
                // change that arrives just after the app left gets what's left of
                // the same while, never a new one.
                val left = pausedAt + UNSENT_GRACE_MS - System.currentTimeMillis()
                if (unsent && left > 0) {
                    web.resumeTimers()
                    web.postDelayed(pauseLater, left)
                } else web.pauseTimers()
            }
            "share" -> runCatching {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, msg.optString("title"))
                    .putExtra(Intent.EXTRA_TEXT, msg.optString("text"))
                startActivity(Intent.createChooser(send, null))
            }
            // System tap feedback; Android skips it if touch feedback is off.
            "haptic" -> web.performHapticFeedback(
                if (msg.optString("kind") == "tick") HapticFeedbackConstants.CLOCK_TICK
                else HapticFeedbackConstants.VIRTUAL_KEY,
            )
            "notify" -> Reminders.set(this, msg.optJSONArray("items") ?: return)
            // Android 13+ asks before notifying; earlier ones allow it from the start.
            "askNotifications" ->
                if (Build.VERSION.SDK_INT >= 33 && !Reminders.allowed(this)) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                else send(JSONObject().put("type", "notifications").put("allowed", Reminders.allowed(this)))
            "openSettings" -> runCatching {
                startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
                )
            }
        }
    }

    /** Only the bundled page itself, never another site, is reopened after a restart. */
    private fun isOwnPage(url: String): Boolean {
        val uri = url.toUri()
        return uri.scheme == "https" && uri.host == APP_HOST
    }

    // Only reachable when WEB_MESSAGE_LISTENER is supported: [page] is set by a bridge message.
    @SuppressLint("RequiresFeature")
    private fun send(json: JSONObject) {
        runCatching { page?.postMessage(json.toString()) }
    }
}
