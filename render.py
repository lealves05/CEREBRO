#!/usr/bin/env python3
"""Gera vídeos curtos da LORLER / R2L2 a partir de um roteiro JSON.

Uso:  python3 render.py specs/roteiro.json videos/saida.mp4

Roteiro (JSON):
{
  "formato": "9x16" | "4x5" | "1x1",
  "cor": "#9b6bff",                 # cor de destaque
  "marca": "LORLER",                # texto do topo (ex.: "LORLER" ou "R2L2 ENGETECH")
  "marca_sub": "SISTEMAS DE GESTÃO",
  "pill": "orbi.lorler.com.br",     # etiqueta no canto superior direito (opcional)
  "musica": true,
  "cenas": [
    {"tipo": "gancho", "l1": "Sua agenda ainda", "l2": "vive no WhatsApp?", "sub": "...", "dur": 3.2},
    {"tipo": "tela", "video": "fontes/telas/orbi.mp4", "inicio": 0, "legenda": "...", "dur": 5},
    {"tipo": "lista", "titulo": "...", "itens": ["...", "..."], "dur": 5},
    {"tipo": "texto", "titulo": "...", "corpo": "...", "dur": 5},
    {"tipo": "numero", "valor": "3", "rotulo": "...", "dur": 3},
    {"tipo": "cta", "l1": "Teste grátis", "l2": "orbi.lorler.com.br", "sub": "...", "logo": true, "dur": 3.5}
  ]
}
Só usa recursos deste repositório (fontes Inter, logotipos e gravações de tela da LORLER).
"""
import json, math, os, subprocess, sys, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

AQUI = os.path.dirname(os.path.abspath(__file__))
FPS = 30
TAM = {"9x16": (1080, 1920), "4x5": (1080, 1350), "1x1": (1080, 1080)}
FONTES = os.path.join(AQUI, "fontes", "fontes-tipograficas")


def fonte(peso, tam):
    return ImageFont.truetype(os.path.join(FONTES, f"Inter-{peso}.otf"), tam)


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def ease(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def quebrar(draw, texto, f, largura):
    linhas = []
    for par in str(texto).split("\n"):
        palavras, atual = par.split(), ""
        for p in palavras:
            teste = (atual + " " + p).strip()
            if draw.textlength(teste, font=f) <= largura or not atual:
                atual = teste
            else:
                linhas.append(atual)
                atual = p
        linhas.append(atual)
    return linhas


def ajustar(draw, texto, peso, tam, largura, max_linhas):
    while tam > 26:
        f = fonte(peso, tam)
        ls = quebrar(draw, texto, f, largura)
        if len(ls) <= max_linhas and all(draw.textlength(l, font=f) <= largura for l in ls):
            return f, ls
        tam -= 4
    f = fonte(peso, tam)
    return f, quebrar(draw, texto, f, largura)


def fundo(W, H, cor):
    base = Image.new("RGB", (W, H), (10, 10, 14))
    glow = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    r = int(W * 0.75)
    d.ellipse((-r // 2, -r // 2, r, r), fill=tuple(int(c * 0.55) for c in cor))
    d.ellipse((W - r // 2, H - r // 1.4, W + r // 2, H + r // 3), fill=tuple(int(c * 0.35) for c in cor))
    glow = glow.filter(ImageFilter.GaussianBlur(W // 5))
    out = Image.blend(base, glow, 0.85)
    # granulado leve
    ruido = (np.random.default_rng(7).normal(0, 4, (H, W, 1))).astype(np.int16)
    arr = np.clip(np.asarray(out).astype(np.int16) + ruido, 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def rounded(img, raio):
    m = Image.new("L", img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, img.size[0] - 1, img.size[1] - 1), raio, fill=255)
    out = img.convert("RGBA")
    out.putalpha(m)
    return out


class Video:
    def __init__(self, spec):
        self.s = spec
        self.W, self.H = TAM[spec.get("formato", "9x16")]
        self.cor = hex2rgb(spec.get("cor", "#f7920f"))
        self.bg = fundo(self.W, self.H, self.cor)
        self.m = int(self.W * 0.07)  # margem
        logo_path = os.path.join(AQUI, "fontes", "marca", "lorler-claro.png")
        self.logo = Image.open(logo_path).convert("RGBA") if os.path.exists(logo_path) else None
        self.cache = {}

    # ---------- elementos fixos ----------
    def topo(self, img, d, prog, n_cenas, i_cena):
        m, W = self.m, self.W
        y = int(self.H * 0.035)
        # barras de progresso (estilo stories)
        gap, total = 10, W - 2 * m
        bw = (total - gap * (n_cenas - 1)) / n_cenas
        for k in range(n_cenas):
            x0 = m + k * (bw + gap)
            d.rounded_rectangle((x0, y, x0 + bw, y + 6), 3, fill=(255, 255, 255, 60))
            frac = 1 if k < i_cena else (prog if k == i_cena else 0)
            if frac > 0:
                d.rounded_rectangle((x0, y, x0 + bw * frac, y + 6), 3, fill=(255, 255, 255, 230))
        y += 36
        f1, f2 = fonte("ExtraBold", 34), fonte("SemiBold", 22)
        marca = self.s.get("marca", "LORLER")
        d.text((m, y), marca, font=f1, fill=(255, 255, 255))
        x = m + d.textlength(marca, font=f1) + 14
        d.text((x, y + 10), self.s.get("marca_sub", "SISTEMAS DE GESTÃO"), font=f2, fill=(200, 200, 210))
        pill = self.s.get("pill")
        if pill:
            fp = fonte("Bold", 26)
            tw = d.textlength(pill, font=fp)
            x1 = W - m
            x0 = x1 - tw - 40
            d.rounded_rectangle((x0, y - 4, x1, y + 42), 23, fill=self.cor)
            d.text((x0 + 20, y + 3), pill, font=fp, fill=(255, 255, 255))

    # ---------- cenas ----------
    def aparecer(self, d, img, t, atraso, desenhar):
        a = ease((t - atraso) / 0.45)
        if a <= 0:
            return
        camada = Image.new("RGBA", img.size, (0, 0, 0, 0))
        dc = ImageDraw.Draw(camada)
        desenhar(dc, camada, int((1 - a) * 40))
        if a < 1:
            alpha = camada.getchannel("A").point(lambda v: int(v * a))
            camada.putalpha(alpha)
        img.alpha_composite(camada)

    def texto_centro(self, dc, linhas, f, y, cor):
        for l in linhas:
            w = dc.textlength(l, font=f)
            dc.text(((self.W - w) / 2, y), l, font=f, fill=cor)
            y += int(f.size * 1.12)
        return y

    def cena_gancho(self, img, d, c, t):
        W, H, m = self.W, self.H, self.m
        larg = W - 2 * m
        f1, l1 = ajustar(d, c.get("l1", ""), "Black", 104, larg, 3)
        f2, l2 = ajustar(d, c.get("l2", ""), "Black", f1.size, larg, 3)
        alt = (len(l1) + len(l2)) * f1.size * 1.12
        y0 = H * 0.46 - alt / 2

        def p1(dc, cam, dy):
            self.texto_centro(dc, l1, f1, y0 + dy, (255, 255, 255))

        def p2(dc, cam, dy):
            yy = self.texto_centro(dc, l2, f2, y0 + len(l1) * f1.size * 1.12 + dy, self.cor)
            dc.rounded_rectangle((W / 2 - 60, yy + 30, W / 2 + 60, yy + 38), 4, fill=self.cor)
            if c.get("sub"):
                fs, ls = ajustar(dc, c["sub"], "Medium", 38, larg, 3)
                self.texto_centro(dc, ls, fs, yy + 70, (205, 205, 215))

        self.aparecer(d, img, t, 0.0, p1)
        self.aparecer(d, img, t, 0.35, p2)

    def frame_video(self, caminho, inicio, t, w, h, recorte=None, dur=6):
        chave = (caminho, inicio, w, h, tuple(recorte or ()))
        if chave not in self.cache:
            dur = dur + 0.5
            cmd = ["ffmpeg", "-v", "error", "-ss", str(inicio), "-i", os.path.join(AQUI, caminho), "-t", str(dur),
                   "-vf", (f"crop=iw*{recorte[2]}:ih*{recorte[3]}:iw*{recorte[0]}:ih*{recorte[1]}," if recorte else "") + f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={FPS}",
                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
            raw = subprocess.run(cmd, capture_output=True, check=True).stdout
            n = len(raw) // (w * h * 3)
            self.cache[chave] = np.frombuffer(raw, np.uint8)[: n * w * h * 3].reshape(n, h, w, 3)
        fr = self.cache[chave]
        k = min(int(t * FPS), len(fr) - 1)
        return Image.fromarray(fr[k])

    def cena_tela(self, img, d, c, t):
        W, H, m = self.W, self.H, self.m
        cw = W - 2 * m + 40
        ch = int(cw * c.get("proporcao", 0.625))
        x0 = (W - cw) // 2
        y0 = int(H * 0.30) if self.H > self.W * 1.4 else int(H * 0.20)
        zmax = 1.08
        zoom = 1 + (zmax - 1) * min(1, t / max(c.get("dur", 5), 0.1))
        bw, bh = int(cw * zmax), int(ch * zmax)
        base = self.frame_video(c["video"], c.get("inicio", 0), t, bw, bh, c.get("recorte"), c.get("dur", 5))
        vw, vh = bw / zoom, bh / zoom
        fx, fy = c.get("foco", [0.5, 0.5])
        cx, cy = (bw - vw) * fx, (bh - vh) * fy
        fr = base.resize((cw, ch), Image.LANCZOS, box=(cx, cy, cx + vw, cy + vh))
        a = ease(t / 0.45)
        sombra = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(sombra).rounded_rectangle((x0 + 10, y0 + 30, x0 + cw + 10, y0 + ch + 40), 28, fill=(0, 0, 0, int(160 * a)))
        img.alpha_composite(sombra.filter(ImageFilter.GaussianBlur(24)))
        card = rounded(fr, 28)
        if a < 1:
            card.putalpha(card.getchannel("A").point(lambda v: int(v * a)))
        img.alpha_composite(card, (x0, y0 + int((1 - a) * 50)))
        ImageDraw.Draw(img).rounded_rectangle((x0, y0 + int((1 - a) * 50), x0 + cw, y0 + ch + int((1 - a) * 50)), 28,
                                             outline=self.cor + (int(200 * a),), width=4)
        if c.get("titulo"):
            def pt(dc, cam, dy):
                ft, lt = ajustar(dc, c["titulo"], "Black", 70, W - 2 * m, 2)
                yy = y0 - 50 - len(lt) * ft.size * 1.12
                self.texto_centro(dc, lt, ft, yy + dy, (255, 255, 255))
            self.aparecer(d, img, t, 0.1, pt)
        if c.get("legenda"):
            def pl(dc, cam, dy):
                fl, ll = ajustar(dc, c["legenda"], "Bold", 50, W - 2 * m - 40, 4)
                alt = len(ll) * fl.size * 1.2 + 50
                yy = y0 + ch + 60 + dy
                dc.rounded_rectangle((m, yy, W - m, yy + alt), 24, fill=(18, 18, 26, 235))
                dc.rectangle((m, yy + 18, m + 8, yy + alt - 18), fill=self.cor)
                y = yy + 25
                for l in ll:
                    dc.text((m + 36, y), l, font=fl, fill=(255, 255, 255))
                    y += int(fl.size * 1.2)
            self.aparecer(d, img, t, 0.5, pl)

    def cena_lista(self, img, d, c, t):
        W, H, m = self.W, self.H, self.m
        larg = W - 2 * m
        ft, lt = ajustar(d, c.get("titulo", ""), "Black", 76, larg, 3)
        itens = c.get("itens", [])
        fi = fonte("Bold", 46)
        blocos = [quebrar(d, it, fi, larg - 110) for it in itens]
        alt = len(lt) * ft.size * 1.12 + 60 + sum(len(b) * 58 + 54 for b in blocos)
        y0 = max(H * 0.17, H * 0.5 - alt / 2)

        def pt(dc, cam, dy):
            y = y0 + dy
            for l in lt:
                dc.text((m, y), l, font=ft, fill=(255, 255, 255))
                y += int(ft.size * 1.12)
            dc.rounded_rectangle((m, y + 20, m + 120, y + 28), 4, fill=self.cor)

        self.aparecer(d, img, t, 0, pt)
        y = y0 + len(lt) * ft.size * 1.12 + 70
        for k, b in enumerate(blocos):
            yy = y

            def pi(dc, cam, dy, b=b, yy=yy, k=k):
                dc.ellipse((m, yy + 8 + dy, m + 52, yy + 60 + dy), fill=self.cor)
                n = str(k + 1)
                fn = fonte("Black", 32)
                dc.text((m + 26 - dc.textlength(n, font=fn) / 2, yy + 14 + dy), n, font=fn, fill=(255, 255, 255))
                y2 = yy + 6 + dy
                for l in b:
                    dc.text((m + 84, y2), l, font=fi, fill=(240, 240, 245))
                    y2 += 58

            self.aparecer(d, img, t, 0.45 + 0.45 * k, pi)
            y += len(b) * 58 + 54

    def cena_texto(self, img, d, c, t):
        W, H, m = self.W, self.H, self.m
        larg = W - 2 * m
        ft, lt = ajustar(d, c.get("titulo", ""), "Black", 84, larg, 4)
        fc, lc = ajustar(d, c.get("corpo", ""), "Medium", 46, larg, 9)
        alt = len(lt) * ft.size * 1.12 + 70 + len(lc) * fc.size * 1.35
        y0 = max(H * 0.16, H * 0.48 - alt / 2)

        def pt(dc, cam, dy):
            y = y0 + dy
            for l in lt:
                dc.text((m, y), l, font=ft, fill=(255, 255, 255))
                y += int(ft.size * 1.12)
            dc.rounded_rectangle((m, y + 22, m + 120, y + 30), 4, fill=self.cor)

        def pc(dc, cam, dy):
            y = y0 + len(lt) * ft.size * 1.12 + 70 + dy
            for l in lc:
                dc.text((m, y), l, font=fc, fill=(215, 215, 225))
                y += int(fc.size * 1.35)

        self.aparecer(d, img, t, 0, pt)
        self.aparecer(d, img, t, 0.5, pc)

    def cena_numero(self, img, d, c, t):
        W, H, m = self.W, self.H, self.m
        fv = fonte("Black", 300 if self.H > 1500 else 220)
        v = str(c.get("valor", ""))

        def pv(dc, cam, dy):
            w = dc.textlength(v, font=fv)
            dc.text(((W - w) / 2, H * 0.30 + dy), v, font=fv, fill=self.cor)
            fr, lr = ajustar(dc, c.get("rotulo", ""), "Bold", 58, W - 2 * m, 4)
            self.texto_centro(dc, lr, fr, H * 0.30 + fv.size * 1.15 + dy, (255, 255, 255))

        self.aparecer(d, img, t, 0, pv)

    def cena_cta(self, img, d, c, t):
        W, H, m = self.W, self.H, self.m
        larg = W - 2 * m
        y0 = H * 0.30 if H > W * 1.4 else H * 0.22

        def pl(dc, cam, dy):
            y = y0
            if c.get("logo", True) and self.logo is not None:
                lw = int(W * 0.5)
                lg = self.logo.resize((lw, int(self.logo.height * lw / self.logo.width)))
                cam.alpha_composite(lg, (int((W - lw) / 2), int(y + dy)))
                y += lg.height + 70
            f1, l1 = ajustar(dc, c.get("l1", ""), "Black", 92, larg, 2)
            y = self.texto_centro(dc, l1, f1, y + dy, (255, 255, 255))
            f2 = fonte("ExtraBold", 54)
            l2 = c.get("l2", "")
            tw = dc.textlength(l2, font=f2)
            while tw > larg - 40 and f2.size > 30:
                f2 = fonte("ExtraBold", f2.size - 4)
                tw = dc.textlength(l2, font=f2)
            dc.rounded_rectangle(((W - tw) / 2 - 40, y + 30, (W + tw) / 2 + 40, y + 30 + f2.size + 50), 50, fill=self.cor)
            dc.text(((W - tw) / 2, y + 52), l2, font=f2, fill=(255, 255, 255))
            if c.get("sub"):
                fs, ls = ajustar(dc, c["sub"], "Medium", 40, larg, 3)
                self.texto_centro(dc, ls, fs, y + f2.size + 130, (210, 210, 220))

        self.aparecer(d, img, t, 0, pl)

    # ---------- montagem ----------
    def render(self, saida):
        cenas = self.s["cenas"]
        durs = [float(c.get("dur", 4)) for c in cenas]
        total = sum(durs)
        tmp_v = saida + ".v.mp4"
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{self.W}x{self.H}",
               "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p", tmp_v]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        bg = self.bg.convert("RGBA")
        n_total = int(round(total * FPS))
        for n in range(n_total):
            tg = n / FPS
            acc, i = 0.0, 0
            while i < len(cenas) - 1 and tg >= acc + durs[i]:
                acc += durs[i]
                i += 1
            t = tg - acc
            c = cenas[i]
            img = bg.copy()
            d = ImageDraw.Draw(img)
            getattr(self, "cena_" + c["tipo"])(img, d, c, t)
            self.topo(img, ImageDraw.Draw(img), min(1, t / durs[i]), len(cenas), i)
            # transição: escurece nos 0,2 s finais de cada cena (exceto a última)
            fim = durs[i] - t
            if fim < 0.2 and i < len(cenas) - 1:
                img = Image.blend(img, bg, 1 - fim / 0.2)
            p.stdin.write(img.convert("RGB").tobytes())
        p.stdin.close()
        p.wait()
        if self.s.get("musica", True):
            wav = saida + ".wav"
            musica(wav, total, self.s.get("bpm", 104))
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp_v, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
                            "-shortest", "-movflags", "+faststart", saida], check=True)
            os.remove(wav)
        else:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp_v, "-c", "copy", "-movflags", "+faststart", saida], check=True)
        os.remove(tmp_v)


def musica(caminho, dur, bpm=104, sr=44100):
    """Trilha própria e simples (sintetizada aqui): pad de acordes + batida leve. Sem material de terceiros."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    beat = 60 / bpm
    acordes = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G
    freq = lambda midi: 440 * 2 ** ((midi - 69) / 12)
    pad = np.zeros(n)
    compasso = beat * 4
    for k, ac in enumerate(acordes * int(dur // (compasso * 4) + 2)):
        a0 = k * compasso
        if a0 >= dur:
            break
        i0, i1 = int(a0 * sr), min(n, int((a0 + compasso) * sr))
        tt = t[i0:i1] - a0
        env = np.minimum(1, tt / 0.3) * np.minimum(1, (compasso - tt) / 0.3)
        for mn in ac:
            f = freq(mn)
            pad[i0:i1] += env * (np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * 2 * f * tt)) / 3
        f = freq(ac[0] - 12)
        pad[i0:i1] += 0.6 * env * np.sin(2 * np.pi * f * tt)
    bat = np.zeros(n)
    rng = np.random.default_rng(1)
    k = 0
    while k * beat < dur:
        i0 = int(k * beat * sr)
        L = min(int(0.25 * sr), n - i0)
        tt = np.arange(L) / sr
        bat[i0:i0 + L] += 0.9 * np.sin(2 * np.pi * (50 + 60 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
        j0 = int((k + 0.5) * beat * sr)
        L2 = min(int(0.05 * sr), n - j0)
        if L2 > 0:
            bat[j0:j0 + L2] += 0.12 * rng.normal(0, 1, L2) * np.exp(-np.arange(L2) / sr * 80)
        k += 1
    mix = 0.35 * pad + 0.45 * bat
    fade = np.minimum(1, np.minimum(t / 0.8, (dur - t) / 1.2))
    mix = mix * np.clip(fade, 0, 1)
    mix = mix / (np.max(np.abs(mix)) + 1e-9) * 0.6
    with wave.open(caminho, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    os.makedirs(os.path.dirname(os.path.abspath(sys.argv[2])), exist_ok=True)
    Video(spec).render(sys.argv[2])
    print("ok", sys.argv[2])
