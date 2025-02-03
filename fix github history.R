# Step 1: Define the content of the Python callback
callback_code <- "
from git_filter_repo import Commit
def filter_commit(commit):
    if commit.author_email == 'albertomoro98@gmail.com':
        commit.skip()
"

# Step 2: Get the current working directory
current_wd <- getwd()

# Step 3: Define the full path for the Python script
python_script_path <- file.path(current_wd, "filter_commit.py")

# Step 4: Write the callback code to the Python script file
writeLines(callback_code, python_script_path)

# Step 5: Quote the script path to handle spaces in the path
python_script_path_quoted <- shQuote(python_script_path)

# Step 6: Define the git filter-repo command with --force flag and the quoted script path
git_command <- sprintf("git filter-repo --force --commit-callback %s", python_script_path_quoted)

# Step 7: Run the git command in the system shell
system(git_command)
