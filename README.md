# Hacken 🃏

**Hacken** (auch *Chratzen*) ist ein Schweizer Kartenspiel mit Jasskarten. Hier läuft es als Web-App im Browser und auf dem Handy, installierbar als App. Du spielst gegen 2 bis 5 Computer-Gegner oder **online mit Freunden über einen 4-stelligen Code**.

- Echte Deutschschweizer Jasskarten mit zwei Kartensets (AGMüller / Schaffhauser und Elsi Jegen / Frauezogg)
- Vollständige Regeln: Obli-Runde, Klopfen, Kaufen, Mitgehen mit «Letzter», Tauschen mit Stall, Farbzwang mit Trumpf- und Übertrumpfpflicht, Pot mit Obergrenze und Nebenpot
- Online-Spiel: Eine Person erstellt ein Spiel, die anderen treten mit dem Code bei; freie Plätze füllen Computer-Gegner
- Spielregeln direkt im Spiel (Buch-Symbol) und als eigene Seite [`regeln.html`](web/regeln.html)
- Punktestand und Einstellungen bleiben im Browser gespeichert
- Funktioniert nach dem ersten Laden auch offline

## Aufbau

```
web/                 Statische Web-App, kein Build-Schritt nötig
  index.html         Spieltisch
  regeln.html        Spielregeln (auch im Spiel als Dialog)
  styles.css         Design
  js/engine.js       Spiellogik und Computer-Gegner (ohne DOM)
  js/app.js          Oberfläche, Startseite, Lobby, Dialoge, Speicherung
  js/net.js          Online-Spiel (Verbindung über PeerJS/WebRTC)
  js/vendor/         PeerJS 1.5.4 (MIT-Lizenz)
  cards/agm/         Kartenbilder AGMüller (Quelle: jasswelt.ch, geladen mit setup/karten-laden.ps1)
  cards/jegen/       Kartenbilder Elsi Jegen
  sw.js              Offline-Cache
  manifest.webmanifest, icon.svg, icon-*.png
.github/workflows/pages.yml   Deployment auf GitHub Pages (Vorlage: setup/pages.yml)
```

Kartendateien heissen `<Farbe><Rang>.webp`, mit Farbe 0 = Eichel, 1 = Rose, 2 = Schilte, 3 = Schelle und Rang 0 = 6 … 4 = Banner, 5 = Under, 6 = Ober, 7 = König, 8 = Ass. Willst du schärfere Bilder, ersetze die Dateien mit gleichem Namen (Seitenverhältnis 2:3).

## Wie funktioniert das Online-Spiel ohne Server?

GitHub Pages liefert nur Dateien aus und kann selbst keine Spiele verwalten. Deshalb verbinden sich die Browser direkt miteinander (WebRTC):

```
 Gastgeber-Browser (rechnet das Spiel)  ◄──── direkte Verbindung ────►  Mitspieler-Browser
            │                                                                 │
            └──────── kurz zum Kennenlernen: PeerJS-Vermittlung (0.peerjs.com) ┘
```

- Wer «Online-Spiel erstellen» wählt, ist **Gastgeber**: Sein Browser verteilt die Karten, führt die Computer-Gegner und prüft jeden Zug. Die anderen sehen nur ihre eigenen Karten.
- Der 4-stellige Code ist die Adresse des Gastgebers beim kostenlosen Vermittlungsdienst von PeerJS. Danach laufen die Spielzüge direkt zwischen den Geräten.
- Der Gastgeber muss die Seite offen lassen. Fällt jemand raus, spielt der Computer für ihn weiter, bis er mit demselben Code wieder beitritt.
- In seltenen Netzen (manche Firmen- oder Schulnetze) kann die direkte Verbindung blockiert sein. Dann hilft meist mobiles Internet.
- Der öffentliche PeerJS-Dienst ist kostenlos, aber ohne Garantie. Für mehr Zuverlässigkeit kann man einen eigenen PeerJS-Server betreiben und mit `?peer=host:port` testen (siehe `js/net.js`).

## Lokal starten

Die Seite nutzt JavaScript-Module und braucht deshalb einen kleinen Webserver (Doppelklick auf `index.html` reicht nicht):

```powershell
cd C:\Github_Local\hacken\web
python -m http.server 8000
```

Danach `http://localhost:8000` öffnen.

## Auf GitHub Pages veröffentlichen

1. Auf GitHub ein neues Repo anlegen, z. B. `schnre/Hacken`, ohne README.
2. Den Workflow an seinen Platz kopieren und alles hochladen:
   ```powershell
   cd C:\Github_Local\hacken
   mkdir .github\workflows -Force
   copy setup\pages.yml .github\workflows\pages.yml
   git init -b main
   git add .
   git commit -m "Hacken Web-App"
   git remote add origin git@github.com:schnre/Hacken.git
   git push -u origin main
   ```
3. Im Repo **Settings → Pages → Source: GitHub Actions** wählen.
4. Der Workflow *Deploy Web App* veröffentlicht den Ordner `web/` bei jedem Push auf `main`. Die App ist danach unter `https://schnre.github.io/Hacken/` erreichbar.

> GitHub Pages ist für öffentliche Repos kostenlos. Für Pages aus einem privaten Repo brauchst du GitHub Pro.

> **Hinweis zu den Kartenbildern:** Die Bilder stammen aus Fotos der gedruckten Kartensets und sind urheberrechtlich geschützt. Bei einem öffentlichen Repo und einer öffentlichen Pages-Seite sind sie für alle sichtbar.

Nach Änderungen an Dateien in `web/` in `sw.js` die `VERSION` erhöhen, damit installierte Apps sicher die neue Version laden.

## Spielregeln (Kurzfassung)

1. Nur wenn Pot und Nebenpot leer sind (Obli-Runde), zahlen alle den Grundeinsatz in den Pot (max. 20, Rest in den Nebenpot). Jeder bekommt 2 Karten, dann wird die Trumpfkarte aufgedeckt, dann nochmals je 2 Karten.
2. **Obli-Runde** (erste Runde oder Pot und Nebenpot leer): Alle spielen mit, der Geber bekommt die Trumpfkarte und ist Käufer.
3. **Klopfen:** Wer an der Reihe ist und seine Karten noch nicht angeschaut hat, darf klopfen. Er nimmt die offene Trumpfkarte und kauft automatisch.
4. **Kaufen:** Sonst entscheidet jeder der Reihe nach, ob er kauft. Passen alle, wird eine neue Trumpfkarte aufgedeckt. Nach dreimal «alle passen» wird neu gegeben.
5. **Mitgehen:** Alle anderen werden gefragt: mitgehen, passen oder «Letzter» (geht nur mit, wenn danach niemand mehr mitgeht; nur einmal und nur, solange noch niemand mitgegangen ist). Geht niemand mit, muss der Letzte mitgehen.
6. **Tauschen:** Zuerst der Käufer, dann die Mitgeher, je 0 bis 4 Karten. Wer 5 Karten hat, legt danach eine weg. **Stall:** Wer alle 4 tauscht, bekommt 5 und legt eine weg (nur, wenn nicht alle mitspielen und genug Karten da sind).
7. **Stiche:** Der Käufer spielt aus. Farbe angeben; wer nicht kann, muss trumpfen; liegt schon Trumpf, muss er höher sein, sonst darf man untertrumpfen. Nur wer keinen Trumpf hat, legt frei.
8. **Abrechnung:** Soll Käufer 2 Stiche, Mitgeher 1 Stich. Den Pot teilen alle, die ihr Soll erfüllen; der Käufer bekommt doppelt so viel wie ein Mitgeher (Pot 20: 13/7 oder 10/5/5). Wer sein Soll verfehlt, bekommt nichts und zahlt den Pot (Käufer doppelt). Danach wird der Pot aus dem Nebenpot auf 20 aufgefüllt.

Die ausführlichen Regeln stehen in [`web/regeln.html`](web/regeln.html).
