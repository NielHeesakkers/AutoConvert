# AutoConvert

Automatische MKV naar MP4 conversie met HandBrakeCLI, inclusief web interface en e-mail rapportages met TMDB posters.

## Features

- Dagelijkse automatische conversie van MKV naar MP4
- Web interface voor beheer (planning, e-mail ontvangers, SMTP instellingen)
- Handmatig conversie starten/stoppen
- Live log weergave
- HTML e-mail rapport met TMDB film/serie posters
- Versleepbare en inklapbare secties

## Docker installatie

1. Clone de repository:
```bash
git clone https://github.com/NielHeesakkers/AutoConvert.git
cd AutoConvert
```

2. Maak een config bestand aan:
```bash
mkdir -p config
cp config/config.example.json config/config.json
# Pas config/config.json aan met je eigen SMTP instellingen
```

3. Pas `docker-compose.yml` aan met je media paden:
```yaml
volumes:
  - ./config:/app/config
  - ./logs:/app/logs
  - /pad/naar/films:/media/movies
  - /pad/naar/series:/media/series
```

4. Start de container:
```bash
docker compose up -d
```

5. Open de web interface: http://localhost:3742

## Configuratie via web interface

- **Planning** - Stel de dagelijkse conversietijd in
- **Mailserver (SMTP)** - Configureer de SMTP server
- **E-mail ontvangers** - Voeg ontvangers toe, activeer/deactiveer, verstuur test mails
- **Status** - Start/stop conversie handmatig, bekijk live logs
