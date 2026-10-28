"""Client minimal et poli pour IMSLP (API MediaWiki de imslp.org).

- Lecture des métadonnées : aucune connexion nécessaire.
- Téléchargement : connexion facultative avec un compte IMSLP (membres = pas d'attente),
  identifiants lus UNIQUEMENT dans les variables d'environnement IMSLP_USERNAME / IMSLP_PASSWORD.
- 1 requête par seconde au maximum, User-Agent identifiable.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

API = "https://imslp.org/api.php"
UA = "flute-partitions-curator/0.1 (outil pédagogique ; contact : voir README du dépôt)"
SYMBOLIC_EXT = (".mxl", ".musicxml", ".xml", ".mid", ".midi")


@dataclass
class ImslpFile:
    name: str
    description: str = ""
    copyright: str = ""
    index: str = ""

    @property
    def ext(self) -> str:
        return os.path.splitext(self.name)[1].lower()

    @property
    def symbolic(self) -> bool:
        return self.ext in SYMBOLIC_EXT


@dataclass
class ImslpWork:
    title: str
    url: str
    composer: str = ""
    period: str = ""
    instrumentation: str = ""
    year: str = ""
    piece_style: str = ""
    files: list[ImslpFile] = field(default_factory=list)


class Imslp:
    def __init__(self, delay: float = 1.0):
        self.delay = delay
        self._last = 0.0
        self.login_retry_delay = 3.0
        jar = self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.opener.addheaders = [("User-Agent", UA)]
        # Cookie d'acceptation de l'avertissement de droits d'auteur d'IMSLP.
        self._cookie("imslpdisclaimeraccepted", "yes")

    def _cookie(self, name: str, value: str) -> None:
        self.jar.set_cookie(http.cookiejar.Cookie(0, name, value, None, False, "imslp.org", True, False,
                                                  "/", True, False, None, False, None, None, {}))

    def _get(self, url: str, data: dict | None = None) -> bytes:
        wait = self.delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        with self.opener.open(url, body, timeout=60) as res:
            self._last = time.monotonic()
            return res.read()

    def api(self, **params) -> dict:
        params.setdefault("format", "json")
        return json.loads(self._get(f"{API}?{urllib.parse.urlencode(params)}"))

    def login(self) -> str:
        """Connexion au compte IMSLP. Renvoie un message d'état ; un échec n'arrête jamais la collecte.

        IMSLP tourne sur une ancienne version de MediaWiki (pas de `meta=tokens`) : on utilise
        la connexion en deux temps, POST action=login → « NeedToken » → nouveau POST avec lgtoken.
        """
        user, password = os.environ.get("IMSLP_USERNAME"), os.environ.get("IMSLP_PASSWORD")
        if not user or not password:
            return "anonyme (IMSLP_USERNAME / IMSLP_PASSWORD absents)"
        data = {"action": "login", "lgname": user, "lgpassword": password, "format": "json"}
        result = "réponse inattendue"
        for attempt in range(3):  # la connexion d'IMSLP échoue parfois une fois sur deux
            try:
                res = json.loads(self._get(API, data)).get("login", {})
                if res.get("result") == "NeedToken":
                    # Certains MediaWiki derrière un cache ne renvoient pas le cookie de session :
                    # on le pose nous-mêmes à partir de la réponse (cookieprefix + sessionid).
                    if res.get("cookieprefix") and res.get("sessionid"):
                        self._cookie(f"{res['cookieprefix']}_session", res["sessionid"])
                    res = json.loads(self._get(API, data | {"lgtoken": res.get("token", "")})).get("login", {})
                result = res.get("result", "réponse inattendue")
            except Exception as exc:  # noqa: BLE001
                result = f"erreur {exc}"
            if result == "Success":
                return "OK" if attempt == 0 else f"OK (essai {attempt + 1})"
            time.sleep(self.login_retry_delay * (attempt + 1))
        return f"refusée ({result}) — poursuite en anonyme"

    def category_members(self, category: str, limit: int = 500):
        """Pages d'œuvres d'une catégorie (ex. « For flute », « For flute, piano »)."""
        params = {"action": "query", "list": "categorymembers", "cmtitle": f"Category:{category}",
                  "cmlimit": "500", "cmtype": "page"}
        seen = 0
        while True:
            data = self.api(**params)
            for m in data["query"]["categorymembers"]:
                yield m["title"]
                seen += 1
                if seen >= limit:
                    return
            cont = data.get("continue")
            if not cont:
                return
            params.update(cont)

    def work(self, title: str) -> ImslpWork:
        wikitext = self.api(action="parse", page=title, prop="wikitext")["parse"]["wikitext"]["*"]
        return parse_work(title, wikitext)

    def file_url(self, file_name: str) -> str | None:
        data = self.api(action="query", titles=f"File:{file_name}", prop="imageinfo", iiprop="url")
        for page in data["query"]["pages"].values():
            info = page.get("imageinfo")
            if info:
                return absolute_url(info[0]["url"])
        return None

    def download(self, file_name: str, dest: str) -> str:
        url = self.file_url(file_name)
        if not url:
            raise FileNotFoundError(file_name)
        content = self._get(url)
        problem = check_content(file_name, content)
        if problem:
            raise RuntimeError(problem)
        with open(dest, "wb") as fh:
            fh.write(content)
        return dest


def check_content(file_name: str, content: bytes) -> str | None:
    """Vérifie que les octets reçus correspondent bien au type annoncé (IMSLP renvoie parfois une page web :
    attente pour non-membres, avertissement de droits d'auteur…). Renvoie un message d'erreur, ou None."""
    ext = os.path.splitext(file_name)[1].lower()
    head = content[:2048].lstrip()
    if ext == ".pdf":
        ok = content.startswith(b"%PDF")
    elif ext == ".mxl":
        ok = content.startswith(b"PK") or head.startswith((b"<?xml", b"<score-partwise", b"<!DOCTYPE score"))
    elif ext in (".mid", ".midi"):
        ok = content.startswith(b"MThd")
    else:
        ok = head.startswith((b"<?xml", b"<score-partwise", b"<!DOCTYPE score"))
    if ok:
        return None
    title = re.search(rb"<title>(.*?)</title>", content[:20000], re.I | re.S)
    what = f"page web « {title.group(1).decode('utf-8', 'replace').strip()[:80]} »" if title else f"contenu inattendu {head[:40]!r}"
    return f"IMSLP a renvoyé une {what} au lieu du fichier {file_name}"


def absolute_url(url: str) -> str:
    """IMSLP renvoie des adresses relatives au protocole (« //imslp.org/images/… »)."""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return "https://imslp.org" + url
    return url


def _field(text: str, name: str) -> str:
    m = re.search(rf"\|\s*{re.escape(name)}\s*=\s*(.*)", text)
    return re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", m.group(1)).strip() if m else ""


def parse_work(title: str, wikitext: str) -> ImslpWork:
    composer = title.rsplit("(", 1)[-1].rstrip(")") if "(" in title else ""
    work = ImslpWork(
        title=title,
        url="https://imslp.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
        composer=composer,
        period=_field(wikitext, "Composer Time Period") or _field(wikitext, "Piece Style"),
        instrumentation=_field(wikitext, "Instrumentation"),
        year=_field(wikitext, "Year/Date of Composition"),
        piece_style=_field(wikitext, "Piece Style"),
    )
    # Chaque bloc {{#fte:imslpfile ...}} décrit une édition et ses fichiers numérotés.
    for block in re.split(r"\{\{#fte:imslpfile", wikitext)[1:]:
        copyright_ = _field(block, "Copyright")
        for m in re.finditer(r"\|\s*File Name (\d+)\s*=\s*(.+)", block):
            n, name = m.group(1), m.group(2).strip()
            work.files.append(ImslpFile(name=name, description=_field(block, f"File Description {n}"), copyright=copyright_))
    return work


def is_public_domain(copyright_: str) -> bool:
    """Garde le domaine public et les licences Creative Commons réutilisables (attribution conservée)."""
    c = copyright_.lower()
    if "non-pd" in c or "all rights reserved" in c or "noncommercial" in c:
        return False
    return "public domain" in c or "creative commons attribution" in c or "cc0" in c
