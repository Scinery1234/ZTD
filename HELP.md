# ZTD - Help Guide

This guide provides detailed instructions on how to use the ZTD CLI Task Manager.

## Usage

To run the app for the first time:

```bash
python 'ZTD_APP_CODE.py'
```
The program will display a menu with various task management options. You can navigate by entering the corresponding command.

**Example commands:**

```bash
add email boss @work !urgent ~daily
list
done 2
category 1 2 work
recur 1 daily
priority 1 urgent
delete 1,2
```

Commands are designed to be shorthand for speed and efficiency.  
They must be typed accurately to work correctly.

---

## Commands

### Task Management
- `add <task description>` — Add a new task. Add multiple with commas.  
  Example:  
  ```bash
  add email boss @work !urgent ~daily ^tomorrow
  ```
- `list` — Show all tasks.  
- `done <task_id#>` — Mark a task as completed.  
- `delete <task_id#> <task_id#> ...` — Delete one or more tasks.  
- `move <from> <to>` — Move a task from one position to another.

### Task Details
- `priority <task_id#> <priority>` — Set priority (`urgent`, `today`, `tomorrow`, `later`).  
- `category <task_id#> <category>` — Set category.  
- `recur <task_id#> <frequency>` — Set recurrence (`daily`, `weekly`, `monthly`).  
- `duedate <task_id#> <due date>` — Set or update due date.  
  Example:  
  ```bash
  duedate 2 4/9/25
  ```

### Filtering & Views
- `showdone` — View completed tasks.  
- `categories` — View tasks grouped by category.

### Other
- `save` — Save tasks manually.  
- `help` — Show help message.  
- `exit` — Save and exit the program.

---

## Notes
- Tasks are saved to `tasks.json`  
- Completed tasks are saved to `done_tasks.json`  
- Recurring tasks reappear based on the **last completed date**  
- Supports natural language due dates like `^tomorrow` or `^06/10/25`

---