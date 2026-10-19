import json


def backup_body(version=2, app_name="paiti-rujuan"):
    return json.dumps(
        {
            "app": app_name,
            "version": version,
            "exportedAt": "2026-10-20T00:00:00.000Z",
            "counts": {"questions": 0, "wrongBook": 0, "practiceLog": 0, "settings": 0},
            "data": {"banks": [], "questions": [], "wrongBook": [], "practiceLog": [], "settings": []},
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def test_upload_then_download_exact_json(client, login):
    headers = login()["headers"]
    body = backup_body()
    uploaded = client.put("/api/backup", content=body.encode(), headers=headers)
    assert uploaded.status_code == 200
    assert uploaded.json()["version"] == 2
    assert uploaded.json()["updatedAt"]

    downloaded = client.get("/api/backup", headers=headers)
    assert downloaded.status_code == 200
    assert downloaded.text == body


def test_rejects_wrong_app_or_future_version(client, login):
    headers = login()["headers"]
    wrong_app = client.put("/api/backup", content=backup_body(app_name="other"), headers=headers)
    assert wrong_app.status_code == 400

    future = client.put("/api/backup", content=backup_body(version=3), headers=headers)
    assert future.status_code == 400


def test_rejects_oversized_backup(client, monkeypatch, login):
    monkeypatch.setenv("MAX_UPLOAD_MB", "0")
    response = client.put("/api/backup", content=backup_body(), headers=login()["headers"])
    assert response.status_code == 413


def test_user_cannot_read_another_users_backup(client, login):
    owner = login()["headers"]
    other = login()["headers"]
    assert client.put("/api/backup", content=backup_body(), headers=owner).status_code == 200
    assert client.get("/api/backup", headers=other).status_code == 404


def test_missing_backup_is_404(client, login):
    assert client.get("/api/backup", headers=login()["headers"]).status_code == 404
