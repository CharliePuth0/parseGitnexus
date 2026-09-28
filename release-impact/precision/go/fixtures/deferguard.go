package main

func deferGuard(err error, n int) int {
	total := 0
	defer record(total)
	if err != nil {
		return -1
	}
	total = n
	return total
}

func record(v int) {}
