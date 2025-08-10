# Security Notice

## Data Storage & Security Limitations

ZTD stores all active and completed tasks in two local files:

- `tasks.json` — Stores active tasks
- `done_tasks.json` — Stores completed tasks

**Important:** These files are stored in **plain text JSON format**. This means anyone with access to your computer’s file system can open and view the contents without restriction. If your tasks contain sensitive or personal information, this could lead to a **privacy breach**.

### Responsibility Disclaimer
The ZTD developers are **not responsible** for any unauthorised access to, or disclosure of, data stored in these files. It is the **user’s responsibility** to ensure these files are stored securely and to take precautions when adding sensitive data.

---

## Improving Data Security

If you wish to protect your stored tasks, you can encrypt them using third-party libraries such as [cryptography](https://pypi.org/project/cryptography/).

### Example: Encrypting Your Tasks with `cryptography`

1. **Install the library:**
   ```bash
   pip install cryptography

2. **Basic usage pattern:**
   - Convert your JSON file content into bytes
   - Use the `Fernet` class from `cryptography` to encrypt the data
   - Save the encrypted bytes to a file instead of plain text JSON
   - To read tasks back, decrypt them with your secret key

3. **Reference documentation:**
   - [Cryptography Documentation](https://cryptography.io/en/latest/fernet/)

---

## Recommendations
- Keep backups of your encrypted files and your encryption key in a safe location.
- Avoid storing highly sensitive personal or financial information in ZTD unless encryption is implemented.
- Restrict access to the directory containing your ZTD files.